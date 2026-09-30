import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { identifier } from './money.js';
import { QUICKNET_PROTOCOL, QUICKNET_CHAIN_HASH, quicknetTargetForCutoff, verifyQuicknetBeacon, deriveBeaconSpinOutcome } from './round-entropy.js';

export const SPIN_RANDOMNESS_ALGORITHM = 'sha256-rejection-u32be-v1';
const COMMIT_DOMAIN = 'playqube:spin-win:commit:v1';
const DRAW_DOMAIN = 'playqube:spin-win:draw:v1';
// Largest multiple of 37 strictly below 2^32. The seven trailing values
// are discarded, rather than folded into the first seven wheel numbers.
const ACCEPT_BELOW = 4_294_967_289;
const MAX_DRAW_ATTEMPTS = 128;

function validateTerms(roundId: string, rulesId: string, seedHex: string): void {
  identifier(roundId, 'Round ID');
  if (rulesId !== SPIN90_RULES_ID) throw new RangeError('Unsupported committed Spin rules');
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new RangeError('Spin seed must be 32 bytes of lowercase hexadecimal');
  }
}

/** Published before admission; round and rules terms are part of the proof. */
export function spinSeedCommitment(roundId: string, rulesId: string, seedHex: string): string {
  validateTerms(roundId, rulesId, seedHex);
  return createHash('sha256').update(`${COMMIT_DOMAIN}\n${roundId}\n${rulesId}\n${seedHex}`, 'utf8').digest('hex');
}

export function verifySpinSeedCommitment(
  roundId: string, rulesId: string, seedHex: string, commitmentSha256: string,
): boolean {
  validateTerms(roundId, rulesId, seedHex);
  return typeof commitmentSha256 === 'string' && /^[0-9a-f]{64}$/.test(commitmentSha256) &&
    spinSeedCommitment(roundId, rulesId, seedHex) === commitmentSha256;
}

/**
 * Reproducible, unbiased draw from a committed seed. No ticket, payout,
 * bankroll or previous outcome is an input. The owner knows the seed before
 * betting: this proves audit reproducibility, not independent operator entropy
 * or secrecy from a privileged owner. Live activation needs a reviewed entropy
 * and commitment-publication protocol. Exhausting the bound fails closed.
 */
export function deriveSpinCommittedOutcome(roundId: string, rulesId: string, seedHex: string): number {
  validateTerms(roundId, rulesId, seedHex);
  for (let counter = 0; counter < MAX_DRAW_ATTEMPTS; counter++) {
    const digest = createHash('sha256')
      .update(`${DRAW_DOMAIN}\n${roundId}\n${rulesId}\n${seedHex}\n${counter}`, 'utf8').digest();
    const word = digest.readUInt32BE(0);
    if (word < ACCEPT_BELOW) return word % 37;
  }
  throw new Error('Committed Spin sampling exhausted its bound');
}

interface RoundRow {
  id: string; stream_id: string; game_key: string; rules_id: string; mode: string; state: string;
  opens_ms: bigint; closes_ms: bigint; outcome: number | null; drawn_at: Date | null;
}
interface SeedRow {
  seed_hex: string; commitment_sha256: string; algorithm: string; prepared_at: Date; revealed_at: Date | null;
}

async function lockDormantRound(tx: Prisma.TransactionClient, roundId: string): Promise<RoundRow> {
  // This is an internal owner operation. Do not add the owner credential to the
  // API/worker, or expose these helpers as a player route.
  const [access] = await tx.$queryRaw<Array<{ is_owner: boolean }>>`
    SELECT CURRENT_USER = pg_catalog.pg_get_userbyid(c.relowner) AS is_owner
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='scheduled_game_rounds'`;
  if (!access?.is_owner) throw new Error('Dormant financial draw is owner-only');
  const [identity] = await tx.$queryRaw<Array<{ stream_id: string }>>`
    SELECT stream_id FROM public.scheduled_game_rounds WHERE id=${roundId}`;
  if (!identity) throw new Error('Scheduled Spin round not found');
  // BEFORE row locks: all schedule triggers take this same stream lock.
  await tx.$queryRaw`SELECT 1 FROM (SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(${'scheduled-round:' + identity.stream_id},0))) AS lock_wait`;
  const [round] = await tx.$queryRaw<RoundRow[]>`
    SELECT id,stream_id,game_key,rules_id,mode,state,opens_ms,closes_ms,outcome,drawn_at
    FROM public.scheduled_game_rounds WHERE id=${roundId} FOR UPDATE`;
  if (!round || round.game_key !== 'spin_win' || round.rules_id !== SPIN90_RULES_ID || round.mode !== 'FINANCIAL') {
    throw new Error('Round does not match dormant financial Spin rules');
  }
  return round;
}

async function loadSeed(tx: Prisma.TransactionClient, roundId: string): Promise<SeedRow | undefined> {
  const [seed] = await tx.$queryRaw<SeedRow[]>`
    SELECT seed_hex,commitment_sha256,algorithm,prepared_at,revealed_at
    FROM public.house_round_randomness WHERE round_id=${roundId} FOR UPDATE`;
  return seed;
}

function validateSeed(round: RoundRow, seed: SeedRow): void {
  if (![SPIN_RANDOMNESS_ALGORITHM, QUICKNET_PROTOCOL].includes(seed.algorithm) ||
      !verifySpinSeedCommitment(round.id, round.rules_id, seed.seed_hex, seed.commitment_sha256)) {
    throw new Error('Committed Spin randomness proof mismatch');
  }
}

/** Prepare once, before the first accepted ticket. Returns no secret seed. */
export async function prepareDormantSpinRandomness(owner: PrismaClient, roundId: string) {
  identifier(roundId, 'Round ID');
  return owner.$transaction(async (tx) => {
    const round = await lockDormantRound(tx, roundId);
    const existing = await loadSeed(tx, roundId);
    if (existing) {
      validateSeed(round, existing);
      return { roundId, rulesId: round.rules_id, commitmentSha256: existing.commitment_sha256,
        algorithm: existing.algorithm, isReplay: true };
    }
    const [clock] = await tx.$queryRaw<Array<{ now_ms: bigint }>>`
      SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::bigint AS now_ms`;
    if (round.state !== 'OPEN' || clock.now_ms < round.opens_ms || clock.now_ms >= round.closes_ms) {
      throw new Error('Round cannot prepare randomness after its cutoff');
    }
    const [ticket] = await tx.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM public.economic_operations o
        WHERE o.snapshot->'financialTicket'->>'roundId'=${roundId}) AS exists`;
    if (ticket.exists) throw new Error('Round randomness must precede every financial ticket');
    const seedHex = randomBytes(32).toString('hex');
    const commitmentSha256 = spinSeedCommitment(round.id, round.rules_id, seedHex);
    await tx.$executeRaw`
      INSERT INTO public.house_round_randomness(round_id,seed_hex,commitment_sha256,algorithm)
      VALUES (${roundId},${seedHex},${commitmentSha256},${SPIN_RANDOMNESS_ALGORITHM})`;
    // A PostgreSQL deferred proof failure must reject before callback return.
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return { roundId, rulesId: round.rules_id, commitmentSha256,
      algorithm: SPIN_RANDOMNESS_ALGORITHM, isReplay: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 20_000, maxWait: 5_000 });
}

/** Reveal and persist exactly once after the locked round's original cutoff. */
export async function drawDormantSpinRound(owner: PrismaClient, roundId: string) {
  identifier(roundId, 'Round ID');
  return owner.$transaction(async (tx) => {
    const round = await lockDormantRound(tx, roundId);
    if (round.state === 'CANCELLED') throw new Error('Cancelled Spin round cannot be drawn');
    const seed = await loadSeed(tx, roundId);
    if (!seed) throw new Error('Spin round has no pre-admission commitment');
    validateSeed(round, seed);
    const beacon = seed.algorithm === QUICKNET_PROTOCOL ? await verifiedStoredBeacon(tx, round) : null;
    const outcome = beacon ? deriveBeaconSpinOutcome(round.id, round.rules_id, seed.seed_hex, beacon)
      : deriveSpinCommittedOutcome(round.id, round.rules_id, seed.seed_hex);
    if (round.state === 'DRAWN') {
      if (round.outcome !== outcome || !round.drawn_at || !seed.revealed_at) {
        throw new Error('Stored Spin draw does not match its commitment');
      }
      return { roundId, rulesId: round.rules_id, outcome, seedHex: seed.seed_hex,
        commitmentSha256: seed.commitment_sha256, algorithm: seed.algorithm,
        drawnAt: round.drawn_at, ...(beacon ? { beacon } : {}), isReplay: true };
    }
    const [clock] = await tx.$queryRaw<Array<{ now_ms: bigint }>>`
      SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::bigint AS now_ms`;
    if (round.state !== 'OPEN' || clock.now_ms < round.closes_ms || seed.revealed_at) {
      throw new Error('Spin round has not reached its draw cutoff');
    }
    const [lateTicket] = await tx.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM public.scheduled_stake_holds h
        JOIN public.economic_operations o ON o.id=h.hold_operation_id
        JOIN public.house_round_randomness r ON r.round_id=${roundId}
        WHERE o.snapshot->'financialTicket'->>'roundId'=${roundId}
          AND h.created_at < r.prepared_at) AS exists`;
    if (lateTicket.exists) throw new Error('Spin commitment did not precede accepted tickets');
    await tx.$executeRaw`UPDATE public.house_round_randomness
      SET revealed_at=pg_catalog.clock_timestamp() WHERE round_id=${roundId}`;
    const [drawn] = await tx.$queryRaw<Array<{ drawn_at: Date }>>`
      UPDATE public.scheduled_game_rounds SET state='DRAWN',outcome=${outcome},drawn_at=pg_catalog.clock_timestamp()
      WHERE id=${roundId} RETURNING drawn_at`;
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return { roundId, rulesId: round.rules_id, outcome, seedHex: seed.seed_hex,
      commitmentSha256: seed.commitment_sha256, algorithm: seed.algorithm,
      drawnAt: drawn.drawn_at, ...(beacon ? { beacon } : {}), isReplay: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 20_000, maxWait: 5_000 });
}


interface BeaconRow {
  chain_hash: string; beacon_round: bigint; beacon_time_ms: bigint;
  signature_hex: string | null; randomness_hex: string | null; received_at: Date | null;
}
async function loadBeacon(tx: Prisma.TransactionClient, roundId: string) {
  const [pin] = await tx.$queryRaw<BeaconRow[]>`SELECT chain_hash,beacon_round,beacon_time_ms,
    signature_hex,randomness_hex,received_at FROM public.house_round_beacon_pins WHERE round_id=${roundId}`;
  return pin;
}
function validateBeaconPin(round: Pick<RoundRow, 'closes_ms'>, pin: BeaconRow) {
  const target = quicknetTargetForCutoff(Number(round.closes_ms));
  if (pin.chain_hash !== QUICKNET_CHAIN_HASH || BigInt(target.beaconRound) !== pin.beacon_round ||
      BigInt(target.beaconTimeMs) !== pin.beacon_time_ms) throw new Error('Stored future beacon target mismatch');
}
async function verifiedStoredBeacon(tx: Prisma.TransactionClient, round: RoundRow) {
  const pin = await loadBeacon(tx, round.id);
  if (!pin) throw new Error('Future-beacon round lacks its immutable target');
  validateBeaconPin(round, pin);
  if (!pin.signature_hex || !pin.randomness_hex || !pin.received_at) throw new Error('Pinned beacon proof is pending');
  return verifyQuicknetBeacon(Number(round.closes_ms), {
    round: Number(pin.beacon_round), signature: pin.signature_hex, randomness: pin.randomness_hex,
  });
}

/** Read-only readiness. Stored proofs are cryptographically reverified, rather
 * than trusting a SQL marker. A missing event never falls back to a seed draw.
 */
export async function getDormantSpinEntropyAvailability(tx: Prisma.TransactionClient, roundId: string):
Promise<'NOT_PREPARED' | 'PENDING' | 'READY'> {
  const [round] = await tx.$queryRaw<RoundRow[]>`SELECT id,stream_id,game_key,rules_id,mode,state,
    opens_ms,closes_ms,outcome,drawn_at FROM public.scheduled_game_rounds WHERE id=${roundId}`;
  const [seed] = await tx.$queryRaw<SeedRow[]>`SELECT seed_hex,commitment_sha256,algorithm,prepared_at,revealed_at
    FROM public.house_round_randomness WHERE round_id=${roundId}`;
  if (!round || !seed) return 'NOT_PREPARED';
  validateSeed(round, seed);
  if (seed.algorithm === SPIN_RANDOMNESS_ALGORITHM) return 'READY';
  const pin = await loadBeacon(tx, roundId);
  if (!pin) throw new Error('Future-beacon round lacks its immutable target');
  validateBeaconPin(round, pin);
  if (!pin.signature_hex) return 'PENDING';
  await verifiedStoredBeacon(tx, round);
  return 'READY';
}

/** Explicit opt-in new protocol. Existing historical seeds are never converted.
 * The exact future quicknet event is fixed before any financial ticket.
 */
export async function prepareDormantBeaconSpinRandomness(owner: PrismaClient, roundId: string) {
  identifier(roundId, 'Round ID');
  return owner.$transaction(async (tx) => {
    const round = await lockDormantRound(tx, roundId);
    const existing = await loadSeed(tx, roundId);
    if (existing) {
      validateSeed(round, existing);
      if (existing.algorithm !== QUICKNET_PROTOCOL) throw new Error('Historical randomness cannot change protocol');
      const pin = await loadBeacon(tx, roundId);
      if (!pin) throw new Error('Future-beacon round lacks its immutable target');
      validateBeaconPin(round, pin);
      return { roundId, rulesId: round.rules_id, algorithm: QUICKNET_PROTOCOL,
        commitmentSha256: existing.commitment_sha256, chainHash: pin.chain_hash,
        beaconRound: Number(pin.beacon_round), beaconTimeMs: Number(pin.beacon_time_ms), isReplay: true };
    }
    const target = quicknetTargetForCutoff(Number(round.closes_ms));
    const seedHex = randomBytes(32).toString('hex');
    const commitmentSha256 = spinSeedCommitment(roundId, round.rules_id, seedHex);
    await tx.$executeRaw`INSERT INTO public.house_round_beacon_pins(round_id,chain_hash,beacon_round,beacon_time_ms)
      VALUES (${roundId},${QUICKNET_CHAIN_HASH},${BigInt(target.beaconRound)},${BigInt(target.beaconTimeMs)})`;
    await tx.$executeRaw`INSERT INTO public.house_round_randomness(round_id,seed_hex,commitment_sha256,algorithm)
      VALUES (${roundId},${seedHex},${commitmentSha256},${QUICKNET_PROTOCOL})`;
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return { roundId, rulesId: round.rules_id, algorithm: QUICKNET_PROTOCOL, commitmentSha256,
      chainHash: QUICKNET_CHAIN_HASH, beaconRound: target.beaconRound, beaconTimeMs: target.beaconTimeMs, isReplay: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 20_000, maxWait: 5_000 });
}

/** Import a supplied public proof offline. No arbitrary URL is fetched; the
 * official verifier checks the pinned key, exact round and randomness hash.
 * Proofs are immutable and are reverified again before drawing.
 */
export async function recordDormantSpinBeacon(owner: PrismaClient, roundId: string, proof: unknown) {
  identifier(roundId, 'Round ID');
  return owner.$transaction(async (tx) => {
    const round = await lockDormantRound(tx, roundId);
    const seed = await loadSeed(tx, roundId);
    if (!seed || seed.algorithm !== QUICKNET_PROTOCOL) throw new Error('Round has no future-beacon preparation');
    validateSeed(round, seed);
    const pin = await loadBeacon(tx, roundId);
    if (!pin) throw new Error('Round has no future-beacon target');
    validateBeaconPin(round, pin);
    const verified = await verifyQuicknetBeacon(Number(round.closes_ms), proof);
    if (pin.signature_hex) {
      if (pin.signature_hex !== verified.signatureHex || pin.randomness_hex !== verified.randomnessHex)
        throw new Error('Beacon proof conflicts with stored evidence');
      return { roundId, beaconRound: verified.beaconRound, receivedAt: pin.received_at, isReplay: true };
    }
    if (round.state !== 'OPEN') throw new Error('Round cannot accept new beacon evidence');
    const [recorded] = await tx.$queryRaw<Array<{ received_at: Date }>>`UPDATE public.house_round_beacon_pins
      SET signature_hex=${verified.signatureHex},randomness_hex=${verified.randomnessHex},received_at=pg_catalog.clock_timestamp()
      WHERE round_id=${roundId} RETURNING received_at`;
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return { roundId, beaconRound: verified.beaconRound, receivedAt: recorded.received_at, isReplay: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 20_000, maxWait: 5_000 });
}
