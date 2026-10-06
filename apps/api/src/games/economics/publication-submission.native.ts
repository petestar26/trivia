import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { financialNativeDatabase } from '../../test/financial-native-database.js';
import { offlineTimestampAuthority } from '../../test/offline-timestamp-authority.js';
import { prepareDormantBeaconSpinRandomness } from './house-round-draw.js';
import {
  prepareDormantPublicationRequest,
  readPublicPublicationArchive,
} from './publication-store.js';
import {
  submitDormantPublication,
  TIMESTAMP_SUBMISSION_ENDPOINTS,
} from './publication-submission.js';
import { PUBLICATION_AUTHORITIES } from './publication-authorities.js';
import * as transport from './publication-transport.js';

let database: Awaited<ReturnType<typeof financialNativeDatabase>> | undefined;
let tsa: Awaited<ReturnType<typeof offlineTimestampAuthority>>;
let owner: PrismaClient;
let runtime: PrismaClient | undefined;
let roleCreated = false;
const role = `playqube_submit_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const endpoint = 'https://timestamp.invalid/tsa'; // Mocked; no external request.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const policy = () => ({
  authorities: [tsa.authority],
  endpoints: [{ authorityId: tsa.authority.id, url: endpoint }],
});

async function fixture(remainingMs = 600_000) {
  const id = `sub${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const [clock] = await owner.$queryRaw<Array<{ now: bigint }>>`
    SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT AS now`;
  const opensMs = clock.now + BigInt(remainingMs) - 600_000n;
  const closesMs = opensMs + 600_000n;
  await owner.scheduledGameStream.create({
    data: {
      id,
      gameKey: 'spin_win',
      rulesId: SPIN90_RULES_ID,
      mode: 'FINANCIAL',
      enabled: true,
      anchorMs: opensMs,
      bettingMs: 600_000,
      revealMs: 1000,
      resultMs: 1000,
    },
  });
  const roundId = `${id}:0`;
  await owner.scheduledGameRound.create({
    data: {
      id: roundId,
      streamId: id,
      sequence: 0n,
      gameKey: 'spin_win',
      rulesId: SPIN90_RULES_ID,
      mode: 'FINANCIAL',
      opensMs,
      closesMs,
      revealEndsMs: closesMs + 1000n,
      endsMs: closesMs + 2000n,
    },
  });
  await prepareDormantBeaconSpinRandomness(owner, roundId);
  return roundId;
}
async function prepared(remainingMs?: number) {
  const roundId = await fixture(remainingMs);
  const { archive } = await prepareDormantPublicationRequest(owner, roundId, tsa.authority.id, [
    tsa.authority,
  ]);
  await sleep(30);
  const response = await tsa.issue(Buffer.from(archive.request.derBase64, 'base64'));
  return { roundId, archive, response };
}
async function counts(roundId: string) {
  return owner.$queryRaw`
    SELECT (SELECT count(*)::INT FROM public.house_publication_requests WHERE round_id=${roundId}) AS requests,
      (SELECT count(*)::INT FROM public.house_publication_receipts WHERE round_id=${roundId}) AS receipts`;
}

beforeAll(async () => {
  database = await financialNativeDatabase('settlement');
  owner = database.client;
  tsa = await offlineTimestampAuthority();
  await owner.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  const password = randomBytes(24).toString('hex');
  await owner.$executeRawUnsafe(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`
  );
  roleCreated = true;
  await owner.$queryRaw`SELECT public.ledger_apply_runtime_grants(${role})::TEXT`;
  const url = new URL(database.url);
  url.username = role;
  url.password = password;
  runtime = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
}, 240_000);
afterEach(async () => {
  vi.restoreAllMocks();
  if (database) {
    // No financial operation/hold, wallet or financial activation is permitted.
    expect(await owner.scheduledStakeHold.count()).toBe(0);
    expect(await owner.economicOperation.count()).toBe(0);
    expect(await owner.wallet.count()).toBe(0);
    expect(await owner.$queryRaw`SELECT key FROM public.platform_gates WHERE enabled`).toEqual([]);
  }
});
afterAll(async () => {
  try {
    await runtime?.$disconnect();
    if (roleCreated) {
      await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  } finally {
    await tsa?.dispose();
    await database?.dispose();
  }
});

describe('dormant submission, native PostgreSQL and real test-only signed evidence', () => {
  it('fails closed with empty production provider/trust registries before writing or contacting anything', async () => {
    const roundId = await fixture();
    const post = vi.spyOn(transport, 'postTimestampQuery');
    expect(PUBLICATION_AUTHORITIES).toEqual([]);
    expect(TIMESTAMP_SUBMISSION_ENDPOINTS).toEqual([]);
    await expect(submitDormantPublication(owner, roundId, 'not-approved')).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
    expect(await counts(roundId)).toEqual([{ requests: 0, receipts: 0 }]);
  });
  it.each(['missing', 'duplicate', 'http', 'credentials'])(
    'rejects %s endpoint policy before archive preparation',
    async (kind) => {
      const roundId = await fixture();
      const p = policy();
      if (kind === 'missing') p.endpoints = [];
      if (kind === 'duplicate') p.endpoints.push({ ...p.endpoints[0] });
      if (kind === 'http') p.endpoints[0].url = 'http://localhost/tsa';
      if (kind === 'credentials') p.endpoints[0].url = 'https://user:secret@example.com/tsa';
      const post = vi.spyOn(transport, 'postTimestampQuery');
      await expect(submitDormantPublication(owner, roundId, tsa.authority.id, p)).rejects.toThrow();
      expect(post).not.toHaveBeenCalled();
      expect(await counts(roundId)).toEqual([{ requests: 0, receipts: 0 }]);
    }
  );
  it('imports a real signed reply and replays the stored receipt without a second POST', async () => {
    const { roundId, archive, response } = await prepared();
    const post = vi.spyOn(transport, 'postTimestampQuery').mockResolvedValue(response);
    const first = await submitDormantPublication(owner, roundId, tsa.authority.id, policy());
    expect(first).toMatchObject({ attempts: 1, isReplay: false });
    expect(first.archive.receipt?.derBase64).toBe(response.toString('base64'));
    const again = await submitDormantPublication(owner, roundId, tsa.authority.id, policy());
    expect(again).toEqual({ ...first, attempts: 0, isReplay: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toEqual(Buffer.from(archive.request.derBase64, 'base64'));
    expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 1 }]);
  });
  it('retries transient errors at most three times with byte-identical original query/nonce', async () => {
    const { roundId, archive, response } = await prepared();
    const post = vi
      .spyOn(transport, 'postTimestampQuery')
      .mockRejectedValueOnce(new transport.TimestampTransportUnavailable(true))
      .mockRejectedValueOnce(new transport.TimestampTransportUnavailable(true))
      .mockResolvedValue(response);
    const result = await submitDormantPublication(owner, roundId, tsa.authority.id, policy());
    expect(result.attempts).toBe(3);
    for (const [url, query, timeout] of post.mock.calls) {
      expect(url).toBe(endpoint);
      expect(query).toEqual(Buffer.from(archive.request.derBase64, 'base64'));
      expect(timeout).toBeLessThanOrEqual(5000);
    }
    expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 1 }]);
  });
  it('stops after three transport failures, retaining the original query for a later invocation', async () => {
    const { roundId, archive, response } = await prepared();
    const post = vi
      .spyOn(transport, 'postTimestampQuery')
      .mockRejectedValue(new transport.TimestampTransportUnavailable(true));
    await expect(
      submitDormantPublication(owner, roundId, tsa.authority.id, policy())
    ).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(3);
    expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 0 }]);
    post.mockResolvedValue(response);
    const result = await submitDormantPublication(owner, roundId, tsa.authority.id, policy());
    expect(result.archive.request).toEqual(archive.request);
    expect(result.attempts).toBe(1);
  });
  it('does not retry a terminal transport failure', async () => {
    const { roundId } = await prepared();
    const post = vi
      .spyOn(transport, 'postTimestampQuery')
      .mockRejectedValue(new transport.TimestampTransportUnavailable(false));
    await expect(
      submitDormantPublication(owner, roundId, tsa.authority.id, policy())
    ).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 0 }]);
  });
  it('never treats an HTTP success containing invalid evidence as a receipt or retries it', async () => {
    const { roundId } = await prepared();
    const post = vi
      .spyOn(transport, 'postTimestampQuery')
      .mockResolvedValue(Buffer.from('unsigned timestamp'));
    await expect(
      submitDormantPublication(owner, roundId, tsa.authority.id, policy())
    ).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 0 }]);
  });
  it('rejects a real signed token for a different stored nonce', async () => {
    const one = await prepared();
    const two = await prepared();
    const post = vi.spyOn(transport, 'postTimestampQuery').mockResolvedValue(two.response);
    await expect(
      submitDormantPublication(owner, one.roundId, tsa.authority.id, policy())
    ).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await counts(one.roundId)).toEqual([{ requests: 1, receipts: 0 }]);
  });
  it('crossing the actual database cutoff after a failure stops the next POST', async () => {
    const roundId = await fixture(800);
    const post = vi.spyOn(transport, 'postTimestampQuery').mockImplementation(async () => {
      await sleep(1000);
      throw new transport.TimestampTransportUnavailable(true);
    });
    await expect(
      submitDormantPublication(owner, roundId, tsa.authority.id, policy())
    ).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 0 }]);
    const replay = await prepareDormantPublicationRequest(owner, roundId, tsa.authority.id, [
      tsa.authority,
    ]);
    expect(replay.isReplay).toBe(true);
    await expect(
      submitDormantPublication(owner, roundId, tsa.authority.id, policy())
    ).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('holds neither archive transaction nor round/stream lock during provider I/O', async () => {
    const { roundId, response } = await prepared();
    const other = new PrismaClient({ datasourceUrl: database!.url, log: [] });
    try {
      vi.spyOn(transport, 'postTimestampQuery').mockImplementation(async () => {
        await other.$transaction(async (tx) => {
          const [stream] = await tx.$queryRaw<
            Array<{ stream_id: string }>
          >`SELECT stream_id FROM public.scheduled_game_rounds WHERE id=${roundId}`;
          const [lock] = await tx.$queryRaw<
            Array<{ acquired: boolean }>
          >`SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(${'scheduled-round:' + stream.stream_id},0)) AS acquired`;
          expect(lock.acquired).toBe(true);
          expect(
            await tx.$queryRaw`SELECT id FROM public.scheduled_game_rounds WHERE id=${roundId} FOR UPDATE NOWAIT`
          ).toEqual([{ id: roundId }]);
        });
        return response;
      });
      expect(
        (await submitDormantPublication(owner, roundId, tsa.authority.id, policy())).archive.receipt
      ).not.toBeNull();
    } finally {
      await other.$disconnect();
    }
  });
  it('concurrent different valid provider replies commit once and both return that exact winner', async () => {
    const { roundId, archive, response } = await prepared();
    await sleep(30);
    const response2 = await tsa.issue(Buffer.from(archive.request.derBase64, 'base64'));
    expect(response2.equals(response)).toBe(false);
    const waiting: Array<(bytes: Buffer) => void> = [];
    const post = vi.spyOn(transport, 'postTimestampQuery').mockImplementation(
      () =>
        new Promise<Buffer>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) {
            waiting[0](response);
            waiting[1](response2);
          }
        })
    );
    const other = new PrismaClient({ datasourceUrl: database!.url, log: [] });
    try {
      const results = await Promise.all(
        [owner, other].map((client) =>
          submitDormantPublication(client, roundId, tsa.authority.id, policy())
        )
      );
      expect(post).toHaveBeenCalledTimes(2);
      expect(results[0].archive).toEqual(results[1].archive);
      expect(results.map((r) => r.isReplay).sort()).toEqual([false, true]);
      expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 1 }]);
      expect(await readPublicPublicationArchive(owner, roundId, [tsa.authority])).toEqual(
        results[0].archive
      );
    } finally {
      await other.$disconnect();
    }
  });
  it('a restricted runtime credential cannot start provider I/O', async () => {
    const { roundId } = await prepared();
    const post = vi.spyOn(transport, 'postTimestampQuery');
    await expect(
      submitDormantPublication(runtime!, roundId, tsa.authority.id, policy())
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
    expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 0 }]);
  });
  it('replays a verified archive after the actual cutoff without new provider I/O', async () => {
    const { roundId, response, archive } = await prepared(3000);
    const post = vi.spyOn(transport, 'postTimestampQuery').mockResolvedValue(response);
    const result = await submitDormantPublication(owner, roundId, tsa.authority.id, policy());
    const [clock] = await owner.$queryRaw<Array<{ now: bigint }>>`
      SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT AS now`;
    await sleep(Math.max(0, Number(BigInt(archive.proof.commitment.closesAtMs) - clock.now)) + 30);
    const replay = await submitDormantPublication(owner, roundId, tsa.authority.id, policy());
    expect(replay).toEqual({ ...result, isReplay: true, attempts: 0 });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
