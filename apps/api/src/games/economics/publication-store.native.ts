import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { financialNativeDatabase } from '../../test/financial-native-database.js';
import { offlineTimestampAuthority } from '../../test/offline-timestamp-authority.js';
import { registerPublicProofRoutes } from '../scheduled/public-proof-routes.js';
import { prepareDormantBeaconSpinRandomness } from './house-round-draw.js';
import * as store from './publication-store.js';
import { createPublicationRequest, PublicationWitnessUnavailable } from './publication-witness.js';
import type { PublicationAuthority } from './publication-authorities.js';

let database: Awaited<ReturnType<typeof financialNativeDatabase>> | undefined;
let tsa: Awaited<ReturnType<typeof offlineTimestampAuthority>> | undefined;
let owner: PrismaClient;
let runtime: PrismaClient | undefined;
let roots: readonly PublicationAuthority[];
const role = `playqube_pub_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const server = Fastify({ logger: false, maxParamLength: 128 });
const paused = () => new Promise((resolve) => setTimeout(resolve, 30));

async function fixture() {
  const id = `pub${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const [clock] = await owner.$queryRaw<Array<{ now: bigint }>>`
    SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT AS now`;
  const opensMs = clock.now - 1000n,
    closesMs = opensMs + 600_000n;
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
async function prepared() {
  const roundId = await fixture();
  const result = await store.prepareDormantPublicationRequest(owner, roundId, roots[0].id, roots);
  return { roundId, result };
}
async function responseFor(result: Awaited<ReturnType<typeof prepared>>['result']) {
  await paused(); // Signed uncertainty is after the actual preparation time.
  return tsa!.issue(Buffer.from(result.archive.request.derBase64, 'base64'));
}
async function counts(roundId: string) {
  return owner.$queryRaw`
    SELECT (SELECT count(*)::INT FROM public.house_publication_requests WHERE round_id=${roundId}) AS requests,
      (SELECT count(*)::INT FROM public.house_publication_receipts WHERE round_id=${roundId}) AS receipts`;
}
async function fingerprint() {
  const [row] = await owner.$queryRaw<Array<{ value: string }>>`
    SELECT pg_catalog.md5(pg_catalog.string_agg(t.row,E'\n' ORDER BY t.row)) AS value FROM (
      SELECT pg_catalog.to_jsonb(r)::TEXT AS row FROM public.house_publication_requests r
      UNION ALL SELECT pg_catalog.to_jsonb(r)::TEXT FROM public.house_publication_receipts r
      UNION ALL SELECT pg_catalog.to_jsonb(w)::TEXT FROM public.wallets w
      UNION ALL SELECT pg_catalog.to_jsonb(g)::TEXT FROM public.platform_gates g
    ) t`;
  return row.value;
}
const get = (id: string) =>
  server.inject({
    method: 'GET',
    url: `/scheduled/spin-win/proofs/${encodeURIComponent(id)}/publication`,
  });

beforeAll(async () => {
  database = await financialNativeDatabase('settlement');
  owner = database.client;
  tsa = await offlineTimestampAuthority();
  roots = Object.freeze([tsa.authority]);
  await owner.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  const password = randomBytes(24).toString('hex');
  await owner.$executeRawUnsafe(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`
  );
  await owner.$queryRaw`SELECT public.ledger_apply_runtime_grants(${role})::TEXT`;
  const url = new URL(database.url);
  url.username = role;
  url.password = password;
  runtime = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
  registerPublicProofRoutes(server, runtime);
  await server.ready();
}, 240_000);
afterAll(async () => {
  try {
    vi.restoreAllMocks();
    await server.close();
    await runtime?.$disconnect();
    if (database) {
      await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  } finally {
    await tsa?.dispose();
    await database?.dispose();
  }
});

describe('immutable dormant publication archive, native PostgreSQL and real test-only CMS/TSA', () => {
  it('persists one original query/nonce and returns byte-identical replay', async () => {
    const { roundId, result } = await prepared();
    expect(result.isReplay).toBe(false);
    expect(result.archive.receipt).toBeNull();
    const again = await store.prepareDormantPublicationRequest(owner, roundId, roots[0].id, roots);
    expect(again).toEqual({ ...result, isReplay: true });
    expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 0 }]);
  });
  it('serializes concurrent preparation across independent owner connections', async () => {
    const roundId = await fixture();
    const second = new PrismaClient({ datasourceUrl: database!.url, log: [] });
    try {
      const results = await Promise.all(
        [owner, second].map((client) =>
          store.prepareDormantPublicationRequest(client, roundId, roots[0].id, roots)
        )
      );
      expect(results.filter((result) => !result.isReplay)).toHaveLength(1);
      expect(results[0].archive).toEqual(results[1].archive);
      expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 0 }]);
    } finally {
      await second.$disconnect();
    }
  });
  it('refuses conflicting authority reuse with a controlled 409 and unchanged rows', async () => {
    const { roundId } = await prepared();
    const before = await fingerprint();
    await expect(
      store.prepareDormantPublicationRequest(owner, roundId, 'another-authority', roots)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await fingerprint()).toBe(before);
  });
  it('stores real verified raw receipt bytes once; concurrent import and replay settle once', async () => {
    const { roundId, result } = await prepared();
    const response = await responseFor(result);
    const second = new PrismaClient({ datasourceUrl: database!.url, log: [] });
    try {
      const results = await Promise.all(
        [owner, second].map((client) =>
          store.recordDormantPublicationReceipt(client, roundId, response, roots)
        )
      );
      expect(results.filter((value) => !value.isReplay)).toHaveLength(1);
      expect(results[0].archive).toEqual(results[1].archive);
      expect(Buffer.from(results[0].archive.receipt!.derBase64, 'base64')).toEqual(response);
      expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 1 }]);
      expect(await store.recordDormantPublicationReceipt(owner, roundId, response, roots)).toEqual({
        archive: results[0].archive,
        isReplay: true,
      });
    } finally {
      await second.$disconnect();
    }
  });
  it('refuses different valid receipt reuse and preserves the first response', async () => {
    const { roundId, result } = await prepared();
    const first = await responseFor(result);
    await store.recordDormantPublicationReceipt(owner, roundId, first, roots);
    const other = await responseFor(result);
    expect(other.equals(first)).toBe(false);
    const before = await fingerprint();
    await expect(
      store.recordDormantPublicationReceipt(owner, roundId, other, roots)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await fingerprint()).toBe(before);
  });
  it('rejects invalid signatures, another nonce, oversized data and default empty trust without writes', async () => {
    const { roundId, result } = await prepared();
    const query = await createPublicationRequest(result.archive.proof, roots[0].id, roots);
    const wrongNonce = await tsa!.issue(query.queryDer);
    const response = await responseFor(result);
    const broken = Buffer.from(response);
    broken[broken.length - 1] ^= 1;
    const before = await fingerprint();
    for (const bytes of [wrongNonce, broken, Buffer.alloc(65_537), Buffer.alloc(0)]) {
      await expect(
        store.recordDormantPublicationReceipt(owner, roundId, bytes, roots)
      ).rejects.toThrow(PublicationWitnessUnavailable);
    }
    await expect(store.recordDormantPublicationReceipt(owner, roundId, response)).rejects.toThrow(
      PublicationWitnessUnavailable
    );
    expect(await fingerprint()).toBe(before);
  });
  it('rejects unavailable rounds and keeps failed preparation empty', async () => {
    await expect(
      store.prepareDormantPublicationRequest(owner, 'missing:0', roots[0].id, roots)
    ).rejects.toThrow(PublicationWitnessUnavailable);
    const roundId = await fixture();
    await expect(
      store.prepareDormantPublicationRequest(owner, roundId, roots[0].id)
    ).rejects.toThrow(PublicationWitnessUnavailable);
    expect(await counts(roundId)).toEqual([{ requests: 0, receipts: 0 }]);
  });
  it('allows read-only downloaded archives under the runtime role without seed/key access or writes', async () => {
    const { roundId, result } = await prepared();
    await store.recordDormantPublicationReceipt(owner, roundId, await responseFor(result), roots);
    const before = await fingerprint();
    const data = await store.readPublicPublicationArchive(runtime!, roundId, roots);
    expect(data?.receipt?.derBase64).toBeTruthy();
    expect(JSON.stringify(data)).not.toMatch(/seedHex|secret|PRIVATE KEY/);
    await expect(
      runtime!.$queryRaw`SELECT seed_hex FROM public.house_round_randomness`
    ).rejects.toThrow();
    await expect(
      runtime!.$queryRaw`SELECT secret FROM public.ledger_approval_keys`
    ).rejects.toThrow();
    expect(await fingerprint()).toBe(before);
    expect(await store.readPublicPublicationArchive(runtime!, 'unknown:0', roots)).toBeNull();
    expect(await store.readPublicPublicationArchive(runtime!, 'bad/id', roots)).toBeNull();
  });
  it('rechecks current trust, raw signatures and derived database metadata on every read', async () => {
    const { roundId, result } = await prepared();
    await store.recordDormantPublicationReceipt(owner, roundId, await responseFor(result), roots);
    await expect(store.readPublicPublicationArchive(runtime!, roundId)).rejects.toThrow(
      PublicationWitnessUnavailable
    );
    await expect(
      store.readPublicPublicationArchive(runtime!, roundId, [{ ...roots[0], maxAccuracyMs: 9 }])
    ).rejects.toThrow(PublicationWitnessUnavailable);
    // Simulated owner corruption: always rolled back; guards remain active for
    // real writer/read tests. Derived metadata must never substitute for DER.
    for (const field of ['serial_hex', 'observed_from_ms', 'response_der']) {
      await expect(
        owner.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role=replica');
          if (field === 'serial_hex')
            await tx.$executeRaw`UPDATE public.house_publication_receipts SET serial_hex='a' WHERE round_id=${roundId}`;
          if (field === 'observed_from_ms')
            await tx.$executeRaw`UPDATE public.house_publication_receipts SET observed_from_ms=observed_from_ms-1 WHERE round_id=${roundId}`;
          if (field === 'response_der')
            await tx.$executeRaw`UPDATE public.house_publication_receipts
          SET response_der='broken'::BYTEA,response_sha256=pg_catalog.encode(public.digest('broken'::BYTEA,'sha256'::TEXT),'hex') WHERE round_id=${roundId}`;
          await expect(store.readPublicPublicationArchive(tx, roundId, roots)).rejects.toThrow(
            PublicationWitnessUnavailable
          );
          throw new Error('rollback corruption fixture');
        })
      ).rejects.toThrow('rollback corruption fixture');
    }
    expect(
      (await store.readPublicPublicationArchive(runtime!, roundId, roots))?.receipt
    ).not.toBeNull();
  });
  it('enforces request/receipt immutability, including owner UPDATE, DELETE and TRUNCATE', async () => {
    const { roundId, result } = await prepared();
    await store.recordDormantPublicationReceipt(owner, roundId, await responseFor(result), roots);
    for (const table of ['house_publication_requests', 'house_publication_receipts']) {
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE public.${table} SET round_id=round_id WHERE round_id=$1`,
          roundId
        )
      ).rejects.toThrow('append-only');
      await expect(
        owner.$executeRawUnsafe(`DELETE FROM public.${table} WHERE round_id=$1`, roundId)
      ).rejects.toThrow('append-only');
      await expect(owner.$executeRawUnsafe(`TRUNCATE public.${table} CASCADE`)).rejects.toThrow(
        'append-only'
      );
    }
  });
  it('denies runtime helpers and archive writes even after an accidental direct INSERT grant', async () => {
    const roundId = await fixture();
    await expect(
      store.prepareDormantPublicationRequest(runtime!, roundId, roots[0].id, roots)
    ).rejects.toThrow(PublicationWitnessUnavailable);
    const { roundId: source } = await prepared();
    await owner.$executeRawUnsafe(`GRANT INSERT ON public.house_publication_requests TO "${role}"`);
    try {
      await expect(runtime!.$executeRaw`
        INSERT INTO public.house_publication_requests SELECT * FROM public.house_publication_requests WHERE round_id=${source}`).rejects.toThrow(
        'owner-only'
      );
    } finally {
      await owner.$queryRaw`SELECT public.ledger_apply_runtime_grants(${role})::TEXT`;
    }
    for (const table of ['house_publication_requests', 'house_publication_receipts']) {
      const [acl] = await owner.$queryRawUnsafe<Array<{ writes: boolean; cols: boolean }>>(
        `
        SELECT pg_catalog.has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS writes,
          pg_catalog.has_any_column_privilege($1,$2,'INSERT,UPDATE') AS cols`,
        role,
        `public.${table}`
      );
      expect(acl).toEqual({ writes: false, cols: false });
    }
  });
  it('refuses an assumable NOINHERIT column-writer without changing archive ACLs', async () => {
    const holder = `playqube_pub_holder_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await owner.$executeRawUnsafe(`CREATE ROLE "${holder}"`);
    try {
      await owner.$executeRawUnsafe(`ALTER ROLE "${role}" NOINHERIT`);
      await owner.$executeRawUnsafe(`GRANT "${holder}" TO "${role}"`);
      await owner.$executeRawUnsafe(
        `GRANT INSERT (response_der) ON public.house_publication_receipts TO "${holder}"`
      );
      const before =
        await owner.$queryRaw`SELECT relacl::TEXT FROM pg_catalog.pg_class WHERE oid='public.house_publication_receipts'::pg_catalog.regclass`;
      await expect(
        owner.$queryRaw`SELECT public.ledger_apply_runtime_grants(${role})::TEXT`
      ).rejects.toThrow(`writable through ${holder}`);
      expect(
        await owner.$queryRaw`SELECT relacl::TEXT FROM pg_catalog.pg_class WHERE oid='public.house_publication_receipts'::pg_catalog.regclass`
      ).toEqual(before);
    } finally {
      await owner.$executeRawUnsafe(`REVOKE "${holder}" FROM "${role}"`);
      await owner.$executeRawUnsafe(`DROP OWNED BY "${holder}"`);
      await owner.$executeRawUnsafe(`DROP ROLE "${holder}"`);
      await owner.$executeRawUnsafe(`ALTER ROLE "${role}" INHERIT`);
    }
  });
  it('rolls back a valid receipt if its database insert fails after cryptographic verification', async () => {
    const { roundId, result } = await prepared();
    const bytes = await responseFor(result);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const functionName = `pub_fail_${suffix}`;
    const message = `forced receipt failure ${suffix}`;
    await owner.$executeRawUnsafe(`CREATE FUNCTION public.${functionName}() RETURNS TRIGGER
      LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER ${functionName} AFTER INSERT ON public.house_publication_receipts
      FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
    try {
      const before = await fingerprint();
      await expect(
        store.recordDormantPublicationReceipt(owner, roundId, bytes, roots)
      ).rejects.toThrow(message);
      expect(await counts(roundId)).toEqual([{ requests: 1, receipts: 0 }]);
      expect(await fingerprint()).toBe(before);
    } finally {
      await owner.$executeRawUnsafe(
        `DROP TRIGGER ${functionName} ON public.house_publication_receipts`
      );
      await owner.$executeRawUnsafe(`DROP FUNCTION public.${functionName}()`);
    }
    expect(
      (await store.recordDormantPublicationReceipt(owner, roundId, bytes, roots)).isReplay
    ).toBe(false);
  });
  it('serves safe 404/503 defaults and a verified downloadable JSON response with zero writes', async () => {
    expect((await get('not-present:0')).statusCode).toBe(404);
    const { roundId, result } = await prepared();
    await store.recordDormantPublicationReceipt(owner, roundId, await responseFor(result), roots);
    const refused = await get(roundId);
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({
      success: false,
      error: { code: 'PUBLICATION_UNAVAILABLE', message: 'Publication archive cannot be verified' },
    });
    // Test-only roots injected at the module boundary, never from HTTP input.
    const original = store.readPublicPublicationArchive;
    const spy = vi
      .spyOn(store, 'readPublicPublicationArchive')
      .mockImplementation((client, id) => original(client, id, roots));
    try {
      const before = await fingerprint();
      const response = await get(roundId);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().data).toEqual(await original(runtime!, roundId, roots));
      expect(await fingerprint()).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});
