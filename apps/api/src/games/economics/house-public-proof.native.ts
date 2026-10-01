import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPIN90_RULES_ID, parseSpinPublicProof } from '@socialplay/shared';
import { financialNativeDatabase } from '../../test/financial-native-database.js';
import { registerPublicProofRoutes } from '../scheduled/public-proof-routes.js';
import { readPublicSpinProof } from './house-public-proof.js';
import {
  drawDormantSpinRound,
  prepareDormantBeaconSpinRandomness,
  prepareDormantSpinRandomness,
  recordDormantSpinBeacon,
} from './house-round-draw.js';

const GENESIS = 1_692_803_367_000n;
const GOLDEN = {
  round: 1,
  randomness: '1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a',
  signature:
    'b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b',
};
let database: Awaited<ReturnType<typeof financialNativeDatabase>> | undefined;
let owner: PrismaClient;
let runtime: PrismaClient | undefined;
const role = `playqube_proof_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const server = Fastify({ logger: false, maxParamLength: 128 });

async function fixture(legacy = false) {
  const streamId = `proof${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const roundId = `${streamId}:0`;
  const [clock] = await owner.$queryRaw<Array<{ opens: bigint }>>`
    SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT-500 AS opens`;
  const opensMs = clock.opens,
    closesMs = opensMs + 60_000n;
  await owner.scheduledGameStream.create({
    data: {
      id: streamId,
      gameKey: 'spin_win',
      rulesId: SPIN90_RULES_ID,
      mode: 'FINANCIAL',
      enabled: true,
      anchorMs: opensMs,
      bettingMs: 60_000,
      revealMs: 1000,
      resultMs: 1000,
    },
  });
  await owner.scheduledGameRound.create({
    data: {
      id: roundId,
      streamId,
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
  if (legacy) await prepareDormantSpinRandomness(owner, roundId);
  else await prepareDormantBeaconSpinRandomness(owner, roundId);
  return { streamId, roundId };
}

async function historicalClock(f: Awaited<ReturnType<typeof fixture>>) {
  const closes = GENESIS - 6001n,
    opens = closes - 60_000n;
  // Historical real beacon fixture only: later import/draw/GET all run with
  // ordinary triggers. No financial rows, amounts or gates are fabricated.
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw`UPDATE public.scheduled_game_streams SET anchor_ms=${opens} WHERE id=${f.streamId}`;
    await tx.$executeRaw`UPDATE public.scheduled_game_rounds SET opens_ms=${opens},closes_ms=${closes},
      reveal_ends_ms=${closes + 1000n},ends_ms=${closes + 2000n} WHERE id=${f.roundId}`;
    await tx.$executeRaw`UPDATE public.house_round_beacon_pins SET beacon_round=1,beacon_time_ms=${GENESIS},
      pinned_at=pg_catalog.to_timestamp(${Number(opens + 100n) / 1000}) WHERE round_id=${f.roundId}`;
    await tx.$executeRaw`UPDATE public.house_round_randomness
      SET prepared_at=pg_catalog.to_timestamp(${Number(opens + 200n) / 1000}) WHERE round_id=${f.roundId}`;
  });
}

async function fingerprints() {
  const result: Record<string, string> = {};
  for (const table of [
    'scheduled_game_streams',
    'scheduled_game_rounds',
    'house_round_randomness',
    'house_round_beacon_pins',
    'users',
    'wallets',
    'platform_gates',
    'economic_operations',
    'coin_provenance',
    'coin_lot_entries',
    'scheduled_stake_holds',
    'house_capital_accounts',
  ]) {
    const [row] = await owner.$queryRawUnsafe<Array<{ fingerprint: string }>>(`
      SELECT count(*)::TEXT||':'||COALESCE(md5(string_agg(row_text,E'\\n' ORDER BY row_text)),'empty') AS fingerprint
      FROM (SELECT pg_catalog.to_jsonb(t)::TEXT AS row_text FROM public."${table}" t) rows`);
    result[table] = row.fingerprint;
  }
  return result;
}
const get = (id: string) =>
  server.inject({ method: 'GET', url: `/scheduled/spin-win/proofs/${encodeURIComponent(id)}` });

beforeAll(async () => {
  database = await financialNativeDatabase('settlement');
  owner = database.client;
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
    await server.close();
    await runtime?.$disconnect();
    if (database) {
      await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  } finally {
    await database?.dispose();
  }
});

describe('public financial proof projection under the restricted runtime role', () => {
  it('keeps unrevealed seeds private while returning a downloadable public commitment with no writes', async () => {
    const f = await fixture();
    const before = await fingerprints();
    await expect(
      runtime!.$queryRaw`SELECT seed_hex FROM public.house_round_randomness`
    ).rejects.toThrow();
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await get(f.roundId);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const proof = parseSpinPublicProof(response.json().data);
      expect(proof.stage).toBe('PENDING');
      expect(proof.reveal).toBeNull();
      expect(proof.commitment.roundId).toBe(f.roundId);
      expect(response.body).not.toMatch(
        /seedHex|signature|randomness|userId|wallet|ticket|capital/
      );
    }
    expect(await fingerprints()).toEqual(before);
  });

  it('reveals only after a guarded real-BLS draw and preserves the earlier receipt exactly', async () => {
    const f = await fixture();
    await historicalClock(f);
    const pending = await readPublicSpinProof(runtime!, f.roundId);
    expect(pending?.stage).toBe('PENDING');
    await recordDormantSpinBeacon(owner, f.roundId, GOLDEN);
    // Even an imported beacon is not a seed reveal before the draw commits.
    expect(await readPublicSpinProof(runtime!, f.roundId)).toEqual(pending);
    const drawn = await drawDormantSpinRound(owner, f.roundId);
    const before = await fingerprints();
    const response = await get(f.roundId);
    expect(response.statusCode).toBe(200);
    const proof = parseSpinPublicProof(response.json().data);
    expect(proof.stage).toBe('DRAWN');
    expect(proof.commitment).toEqual(pending!.commitment);
    expect(proof.commitmentHash).toBe(pending!.commitmentHash);
    expect(proof.reveal).toMatchObject({ outcome: drawn.outcome, beacon: GOLDEN });
    expect(await readPublicSpinProof(runtime!, f.roundId)).toEqual(proof);
    expect(await fingerprints()).toEqual(before);
  });

  it('returns bounded safe missing responses without creating rounds or exposing historical seed-only protocols', async () => {
    const legacy = await fixture(true);
    const before = await fingerprints();
    expect((await get('missing-proof:0')).statusCode).toBe(404);
    expect((await get(legacy.roundId)).statusCode).toBe(404);
    expect((await get('invalid.round')).statusCode).toBe(400);
    // Beyond the global router bound, Fastify rejects before route validation.
    expect((await get('a'.repeat(129))).statusCode).toBe(404);
    expect((await get('a'.repeat(128))).json().error.code).toBe('ROUND_PROOF_NOT_FOUND');
    expect(await readPublicSpinProof(runtime!, 'invalid.round')).toBeNull();
    expect(await fingerprints()).toEqual(before);
  });

  it('never serves a forged terminal signature as verified proof', async () => {
    const f = await fixture();
    await historicalClock(f);
    await recordDormantSpinBeacon(owner, f.roundId, GOLDEN);
    await drawDormantSpinRound(owner, f.roundId);
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE public.house_round_beacon_pins SET signature_hex=${'0'.repeat(96)} WHERE round_id=${f.roundId}`;
    });
    const before = await fingerprints();
    const response = await get(f.roundId);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      success: false,
      error: { code: 'ROUND_PROOF_UNAVAILABLE', message: 'Round proof cannot be verified' },
    });
    expect(response.body).not.toMatch(/seedHex|signature|randomness/);
    expect(await fingerprints()).toEqual(before);
  });

  it('installs a strictly pinned stable projection without granting private seed access or enabling a gate', async () => {
    const [functionRow] = await owner.$queryRaw<
      Array<{
        stable: boolean;
        definer: boolean;
        config: string[];
        execute: boolean;
        private: boolean;
      }>
    >`
      SELECT p.provolatile='s' AS stable,p.prosecdef AS definer,p.proconfig AS config,
        pg_catalog.has_function_privilege(${role},p.oid,'EXECUTE') AS execute,
        pg_catalog.has_table_privilege(${role},'public.house_round_randomness','SELECT') AS private
      FROM pg_catalog.pg_proc p WHERE p.oid='public.house_public_spin_proof(text)'::pg_catalog.regprocedure`;
    expect(functionRow).toEqual({
      stable: true,
      definer: true,
      config: ['search_path=pg_catalog, pg_temp'],
      execute: true,
      private: false,
    });
    expect(
      await owner.platformGate.findMany({
        where: { key: { in: ['HOUSE_TICKET_ADMISSION', 'SCHEDULED_STAKE_HOLD'] } },
        select: { enabled: true },
      })
    ).toEqual([{ enabled: false }, { enabled: false }]);
  });
});
