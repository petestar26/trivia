import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@socialplay/database';
import {
  TOGETHER_GAMES,
  TOGETHER_LIMITS,
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  TOGETHER_GAME_DURATION_MS,
  togetherGame,
  togetherSelection,
  togetherSeedCommitment,
  togetherTermsHash,
  togetherRosterHash,
  quicknetTargetForCutoff,
  deriveTogetherOutcome,
  rankTogether,
  settleTogether,
  canonicalJson,
  type TogetherCurrency,
  type TogetherGame,
  type TogetherProof,
  type TogetherRoundView,
  type TogetherSettings,
  type TogetherSnapshot,
  type TogetherTerms,
  type TogetherActivityRound,
  type TogetherGroupActivity,
} from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';
import { applyBalanceChanges, getOrCreateWallet } from '../../economy/wallet-service.js';
import {
  lockEconomicWallet,
  lockUserEconomicScope,
  reserveTogetherCash,
  resolveTogetherCash,
  type PolicyPin,
} from '../../economy/coin-ledger-service.js';
import { resolveJurisdictionForPlay } from '../../economy/jurisdiction-service.js';
import { verifyQuicknetBeacon } from '../economics/round-entropy.js';
import { fetchTogetherBeacon } from './entropy.js';
import { runTogetherJobs, togetherDatabaseWorkerReady, togetherJobHealth } from './jobs.js';
import { preparePresentation } from './presentation.js';
import {
  rows,
  execute,
  policy,
  context,
  dbTime,
  entries,
  round,
  terms,
  tickets,
  type Tx,
  type RoundRow,
  type EntryRow,
} from './store.js';

type Env = {
  PLAY_TOGETHER_ENABLED?: string;
  PLAY_TOGETHER_CASH_ENABLED?: string;
  PLAY_TOGETHER_LIVE_PRESENTATION_ENABLED?: string;
};
export interface CreateTogetherRound {
  groupId: string;
  game: TogetherGame;
  currency: TogetherCurrency;
  entryAmount: number;
  minPlayers: number;
  maxPlayers: number;
  lobbySeconds: number;
  requestId: string;
}
export interface ConfirmTogetherEntry {
  requestId: string;
  termsHash: string;
  selection: number[];
}
export type EntryReply =
  | { accepted: true; entryId: string; receiptId: string }
  | { accepted: false; reason: string; receiptId: string };
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = (r: RoundRow) => r.state === 'PAID' || r.state === 'REFUNDED';
const uuid = (s: unknown) =>
  typeof s === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);

export function createTogetherService(
  db: PrismaClient,
  options: {
    env?: Env;
    workerReady?: () => boolean | Promise<boolean>;
    practiceWorker?: boolean;
    fetchBeacon?: (closesAt: number) => Promise<TogetherProof['beacon']>;
  } = {}
) {
  const env = options.env ?? process.env;
  const ready = options.workerReady ?? (() => togetherDatabaseWorkerReady(db));
  const workerId = randomUUID();
  const fetchBeacon = options.fetchBeacon ?? fetchTogetherBeacon;
  const transaction = <T>(fn: (tx: Tx) => Promise<T>) =>
    db.$transaction(fn, { timeout: 30_000, maxWait: 10_000 });
  const flush = (tx: Tx) => execute(tx, 'SET CONSTRAINTS ALL IMMEDIATE');
  async function admission(s: TogetherSettings, currency: TogetherCurrency, game: TogetherGame) {
    if (env.PLAY_TOGETHER_ENABLED === 'false')
      throw ApiError.forbidden('Group play is currently paused');
    if (!(await ready()))
      throw ApiError.serviceUnavailable(
        'Group processing is reconnecting. Please try again shortly.'
      );
    if (!s.enabledGames.includes(game)) throw ApiError.forbidden('This group game is not open yet');
    if (
      currency === 'GAME_POINTS'
        ? !s.practiceEnabled
        : !s.cashEnabled || env.PLAY_TOGETHER_CASH_ENABLED !== 'true'
    )
      throw ApiError.forbidden(
        currency === 'ETB'
          ? 'Real-money group play is not open yet'
          : 'Practice group play is paused'
      );
  }
  async function cashAdmission(
    tx: Tx,
    userId: string,
    s: TogetherSettings
  ): Promise<PolicyPin | null> {
    if (!s.cashEnabled || env.PLAY_TOGETHER_CASH_ENABLED !== 'true') return null;
    const gates = await rows<{ key: string; enabled: boolean }>(
      tx,
      "SELECT key,enabled FROM platform_gates WHERE key IN ('GROUP_PLAY','CASINO_PLAY') ORDER BY key FOR SHARE"
    );
    if (gates.length !== 2 || gates.some((g) => !g.enabled)) return null;
    const resolution = await resolveJurisdictionForPlay(tx, userId);
    if (!resolution.policy) return null;
    if (resolution.policy.kycTierRequired > 0) {
      const [kyc] = await rows<{ verifiedTier: number }>(
        tx,
        'SELECT "verifiedTier" FROM user_kyc_verifications WHERE "userId"=$1 AND status=\'VERIFIED\' FOR SHARE',
        userId
      );
      if (!kyc || kyc.verifiedTier < resolution.policy.kycTierRequired) return null;
    }
    return { id: resolution.policy.id, version: resolution.policy.version };
  }
  async function balances(tx: Tx, userId: string) {
    const [b] = await rows<{
      cash: bigint;
      points: number;
      cash_reserved: bigint;
      points_reserved: bigint;
    }>(
      tx,
      'SELECT COALESCE((SELECT sum(p."availableAmount") FROM coin_provenance p JOIN coin_ledger_accounts a ON a."userId"=p."userId" AND a."classifiedAt" IS NOT NULL WHERE p."userId"=$1 AND p."lotClass"=\'WITHDRAWABLE\' AND p.state=\'OPEN\'),0)::bigint AS cash,' +
        'COALESCE((SELECT "gamePointsBalance" FROM wallets WHERE "userId"=$1),0)::int AS points,' +
        "COALESCE((SELECT sum(e.amount) FROM play_together_entries e JOIN play_together_rounds r ON r.id=e.round_id WHERE e.user_id=$1 AND e.state='ACCEPTED' AND r.currency='ETB'),0)::bigint AS cash_reserved," +
        "COALESCE((SELECT sum(e.amount) FROM play_together_entries e JOIN play_together_rounds r ON r.id=e.round_id WHERE e.user_id=$1 AND e.state='ACCEPTED' AND r.currency='GAME_POINTS'),0)::bigint AS points_reserved",
      userId
    );
    return {
      cashAvailable: Number(b.cash),
      pointsAvailable: b.points,
      cashReserved: Number(b.cash_reserved),
      pointsReserved: Number(b.points_reserved),
    };
  }
  async function lockWallets(tx: Tx, list: EntryRow[]) {
    for (const id of [...new Set(list.map((e) => e.user_id))].sort()) {
      await getOrCreateWallet(id, tx);
      await rows(tx, 'SELECT id FROM wallets WHERE "userId"=$1 FOR UPDATE', id);
    }
  }
  async function groupOpen(tx: Tx, group: Awaited<ReturnType<typeof context>>) {
    if (group && (group.status !== 'ACTIVE' || group.expiresAt <= (await dbTime(tx))))
      throw ApiError.conflict('This group has closed. Accepted entries remain protected.');
  }
  async function insertRound(
    tx: Tx,
    actorId: string | null,
    groupId: string | null,
    input: Omit<CreateTogetherRound, 'groupId'>,
    s: TogetherSettings,
    requestHash: string
  ) {
    togetherGame(input.game);
    if (
      !['ETB', 'GAME_POINTS'].includes(input.currency) ||
      !uuid(input.requestId) ||
      !Number.isInteger(input.entryAmount) ||
      input.entryAmount % 100 !== 0 ||
      input.entryAmount < s.minEntry ||
      input.entryAmount > s.maxEntry ||
      !Number.isInteger(input.minPlayers) ||
      input.minPlayers < 2 ||
      !Number.isInteger(input.maxPlayers) ||
      input.maxPlayers < input.minPlayers ||
      input.maxPlayers > 20 ||
      !TOGETHER_LIMITS.lobbySeconds.includes(input.lobbySeconds)
    )
      throw ApiError.badRequest('Choose the published entry and participation limits');
    const now = await dbTime(tx),
      id = randomUUID(),
      seed = randomBytes(32).toString('hex');
    const closesAt = new Date(now.getTime() + input.lobbySeconds * 1000);
    const target = quicknetTargetForCutoff(closesAt);
    // New shared playback is initially practice-only. Disabling admission to
    // v2 never disables recovery of already accepted v2 obligations.
    const live =
      input.currency === 'GAME_POINTS' && env.PLAY_TOGETHER_LIVE_PRESENTATION_ENABLED !== 'false';
    const published: TogetherTerms = {
      ...(live
        ? {
            termsVersion: 2 as const,
            presentationVersion: 2 as const,
            presentationDurationMs: TOGETHER_GAME_DURATION_MS[input.game],
          }
        : {}),
      id,
      groupId,
      game: input.game,
      currency: input.currency,
      entryAmount: input.entryAmount,
      feeBps: s.feeBps,
      settingsVersion: s.version,
      minPlayers: input.minPlayers,
      maxPlayers: input.maxPlayers,
      closesAt: closesAt.getTime(),
      rulesId: TOGETHER_RULES_ID,
      feePolicy: TOGETHER_FEE_POLICY,
      seedCommitment: togetherSeedCommitment(id, seed),
      beaconRound: target.beaconRound,
    };
    await execute(
      tx,
      'INSERT INTO play_together_rounds(id,group_id,creator_id,request_id,request_hash,game,currency,entry_amount,fee_bps,policy_version,rules_id,min_players,max_players,created_at,closes_at,recovery_deadline,seed,seed_commitment,terms_hash,beacon_round,presentation_version,presentation_duration_ms) ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)',
      id,
      groupId,
      actorId,
      input.requestId,
      requestHash,
      input.game,
      input.currency,
      input.entryAmount,
      s.feeBps,
      s.version,
      TOGETHER_RULES_ID,
      input.minPlayers,
      input.maxPlayers,
      now,
      closesAt,
      new Date(closesAt.getTime() + TOGETHER_LIMITS.recoveryMs),
      seed,
      published.seedCommitment,
      togetherTermsHash(published),
      target.beaconRound,
      live ? 2 : 1,
      live ? published.presentationDurationMs : null
    );
    return id;
  }
  async function create(userId: string, input: CreateTogetherRound) {
    if (!uuid(input.requestId)) throw ApiError.badRequest('A new request receipt is required');
    const hash = fingerprint([
      userId,
      input.groupId,
      input.game,
      input.currency,
      input.entryAmount,
      input.minPlayers,
      input.maxPlayers,
      input.lobbySeconds,
    ]);
    return transaction(async (tx) => {
      await lockUserEconomicScope(tx, 'together-create:' + input.requestId);
      const [previous] = await rows<RoundRow>(
        tx,
        'SELECT * FROM play_together_rounds WHERE request_id=$1',
        input.requestId
      );
      if (previous) {
        if (previous.creator_id !== userId || previous.request_hash !== hash)
          throw ApiError.conflict('Request receipt was used for different round terms');
        return previous.id;
      }
      const group = await context(tx, userId, input.groupId);
      if (!group || group.ownerId !== userId)
        throw ApiError.forbidden('Only the group owner can create its round');
      await groupOpen(tx, group);
      if (group.expiresAt.getTime() <= (await dbTime(tx)).getTime() + input.lobbySeconds * 1000)
        throw ApiError.conflict('Choose a closing time before this group expires');
      const s = await policy(tx);
      await admission(s, input.currency, input.game);
      if (input.currency === 'ETB' && !(await cashAdmission(tx, userId, s)))
        throw ApiError.forbidden('Real-money group play is not available for this account');
      if (
        (
          await rows(
            tx,
            "SELECT id FROM play_together_rounds WHERE group_id=$1 AND state IN ('OPEN','LOCKED','DRAWN')",
            input.groupId
          )
        ).length
      )
        throw ApiError.conflict('Finish the current round before creating another');
      if (
        (
          await rows(
            tx,
            "SELECT id FROM group_pvp_rounds WHERE group_id=$1 AND state IN ('OPEN','COUNTDOWN','DRAWN')",
            input.groupId
          )
        ).length
      )
        throw ApiError.conflict(
          'Finish the previous points round before creating a new group round'
        );
      const id = await insertRound(tx, userId, input.groupId, input, s, hash);
      await flush(tx);
      return id;
    });
  }
  async function openPublic(userId: string, game: TogetherGame, currency: TogetherCurrency) {
    return transaction(async (tx) => {
      await lockUserEconomicScope(tx, 'together-public:' + game + ':' + currency);
      await context(tx, userId, null);
      const s = await policy(tx);
      await admission(s, currency, game);
      if (!s.publicRoomsEnabled) throw ApiError.forbidden('Public group rooms are not open yet');
      if (currency === 'ETB' && !(await cashAdmission(tx, userId, s)))
        throw ApiError.forbidden('Real-money group play is not available for this account');
      const [prior] = await rows<{ id: string }>(
        tx,
        "SELECT id FROM play_together_rounds WHERE group_id IS NULL AND game=$1 AND currency=$2 AND state IN ('OPEN','LOCKED','DRAWN')",
        game,
        currency
      );
      if (prior) return prior.id;
      const input = {
        game,
        currency,
        entryAmount: s.minEntry,
        minPlayers: 2,
        maxPlayers: 20,
        lobbySeconds: 120,
        requestId: randomUUID(),
      };
      return insertRound(tx, null, null, input, s, fingerprint(input));
    });
  }
  async function enter(
    userId: string,
    roundId: string,
    input: ConfirmTogetherEntry
  ): Promise<EntryReply> {
    if (!uuid(input.requestId)) throw ApiError.badRequest('A new request receipt is required');
    const hash = fingerprint([userId, roundId, input.termsHash, input.selection]);
    return transaction(async (tx) => {
      await lockUserEconomicScope(tx, 'together-entry:' + input.requestId);
      const [prior] = await rows<{
        user_id: string;
        round_id: string;
        request_hash: string;
        response: EntryReply;
      }>(tx, 'SELECT * FROM play_together_requests WHERE id=$1', input.requestId);
      if (prior) {
        if (prior.user_id !== userId || prior.round_id !== roundId || prior.request_hash !== hash)
          throw ApiError.conflict('Request receipt was used with different selections');
        return prior.response;
      }
      const metadata = await round(tx, roundId, false);
      const group = await context(tx, userId, metadata.group_id);
      const r = await round(tx, roundId);
      const save = async (reply: EntryReply) => {
        await execute(
          tx,
          'INSERT INTO play_together_requests(id,user_id,round_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',
          input.requestId,
          userId,
          roundId,
          hash,
          JSON.stringify(reply)
        );
        await flush(tx);
        return reply;
      };
      const reject = (reason: string) =>
        save({ accepted: false, reason, receiptId: input.requestId });
      if (r.state !== 'OPEN' || (await dbTime(tx)) >= r.closes_at)
        return reject('Betting has closed. No money was taken.');
      if (r.terms_hash !== input.termsHash)
        return reject('Round terms changed. Review them before confirming.');
      if (group && (group.status !== 'ACTIVE' || group.expiresAt <= (await dbTime(tx))))
        return reject('This group has closed.');
      const s = await policy(tx);
      try {
        await admission(s, r.currency, r.game);
      } catch (error) {
        if (error instanceof ApiError) return reject(error.message);
        throw error;
      }
      let selection: number[];
      try {
        selection = togetherSelection(r.game, input.selection);
      } catch {
        throw ApiError.badRequest('Complete your selection using the published game rules');
      }
      const confirmed = (await entries(tx, roundId)).filter((e) => e.state === 'ACCEPTED');
      if (confirmed.some((e) => e.user_id === userId))
        return reject('Your entry is already confirmed. Cancel it first to make a new selection.');
      if (confirmed.length >= r.max_players) return reject('This round is full.');
      const pin = r.currency === 'ETB' ? await cashAdmission(tx, userId, s) : null;
      if (r.currency === 'ETB' && !pin)
        return reject('Real-money group play is not available for this account.');
      await getOrCreateWallet(userId, tx);
      await rows(tx, 'SELECT id FROM wallets WHERE "userId"=$1 FOR UPDATE', userId);
      if (r.currency === 'ETB') await lockEconomicWallet(tx, userId);
      const b = await balances(tx, userId);
      if ((r.currency === 'ETB' ? b.cashAvailable : b.pointsAvailable) < r.entry_amount)
        return reject(
          r.currency === 'ETB'
            ? 'Insufficient available real Birr. No entry was accepted.'
            : 'Insufficient Game Points. No entry was accepted.'
        );
      if ((await dbTime(tx)) >= r.closes_at)
        return reject('Betting has closed. No money was taken.');
      const id = randomUUID();
      let holdOperation: string | null = null,
        holdTransaction: string;
      if (pin) {
        const hold = await reserveTogetherCash(tx, userId, {
          entryId: id,
          roundId,
          amount: r.entry_amount,
          policy: pin,
        });
        holdOperation = hold.operationId;
        holdTransaction = hold.walletTransactionId;
      } else {
        const hold = await applyBalanceChanges(tx, userId, [
          {
            currency: 'GAME_POINTS',
            amount: r.entry_amount,
            ledgerType: 'DEBIT',
            transactionType: 'GAME_POINT_DEBIT',
            referenceType: 'GAME',
            referenceId: id,
            description: 'Group practice entry reserved',
          },
        ]);
        holdTransaction = hold.transactions[0].id;
      }
      // The database entry guard checks its own clock again after the wallet
      // operation. A late insert rolls the entire reservation back.
      await execute(
        tx,
        'INSERT INTO play_together_entries(id,round_id,user_id,request_id,selection,amount,policy_id,policy_version,hold_operation_id,hold_transaction_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)',
        id,
        roundId,
        userId,
        input.requestId,
        JSON.stringify(selection),
        r.entry_amount,
        pin?.id ?? null,
        pin?.version ?? null,
        holdOperation,
        holdTransaction
      );
      return save({ accepted: true, entryId: id, receiptId: input.requestId });
    });
  }
  async function payEntry(tx: Tx, r: RoundRow, e: EntryRow, payout: number, refund: boolean) {
    let close: string | null = null,
      prize: string | null = null,
      credit: string | null = null;
    if (r.currency === 'ETB') {
      const result = await resolveTogetherCash(tx, e.user_id, {
        entryId: e.id,
        roundId: r.id,
        holdOperationId: e.hold_operation_id!,
        amount: e.amount,
        payout,
        refund,
        policy: { id: e.policy_id!, version: e.policy_version! },
      });
      close = result.closeOperationId;
      prize = result.prizeOperationId;
      credit = result.walletTransactionId;
    } else if (payout > 0) {
      const result = await applyBalanceChanges(tx, e.user_id, [
        {
          currency: 'GAME_POINTS',
          amount: payout,
          ledgerType: 'CREDIT',
          transactionType: 'GAME_POINT_CREDIT',
          referenceType: 'GAME',
          referenceId: e.id,
          description: refund
            ? 'Group practice entry refunded'
            : 'Group practice prize including returned entry',
        },
      ]);
      credit = result.transactions[0].id;
    }
    await execute(
      tx,
      'UPDATE play_together_entries SET state=$2,close_operation_id=$3,prize_operation_id=$4,payout_transaction_id=$5,payout=$6,closed_at=clock_timestamp() WHERE id=$1',
      e.id,
      refund ? 'REFUNDED' : 'SETTLED',
      close,
      prize,
      credit,
      payout
    );
  }
  async function withdraw(userId: string, roundId: string, entryId: string) {
    return transaction(async (tx) => {
      const metadata = await round(tx, roundId, false);
      await context(tx, userId, metadata.group_id, { refund: true });
      const r = await round(tx, roundId);
      const e = (await entries(tx, roundId)).find(
        (item) => item.id === entryId && item.user_id === userId
      );
      if (!e) throw ApiError.notFound('Your entry was not found');
      if (e.state === 'REFUNDED') return;
      if (r.state !== 'OPEN' || (await dbTime(tx)) >= r.closes_at)
        throw ApiError.conflict(
          'Betting has closed. Your accepted entry will settle automatically.'
        );
      await lockWallets(tx, [e]);
      await payEntry(tx, r, e, e.amount, true);
      await flush(tx);
    });
  }
  async function freeze(tx: Tx, r: RoundRow, active: EntryRow[], reason: string | null) {
    await execute(
      tx,
      'UPDATE play_together_rounds SET state=$2,locked_at=clock_timestamp(),locked_entry_ids=$3::text[],roster_hash=$4,void_reason=$5 WHERE id=$1',
      r.id,
      reason ? 'DRAWN' : 'LOCKED',
      active.map((e) => e.id).sort(),
      togetherRosterHash(tickets(active)),
      reason
    );
  }
  async function cancel(userId: string, roundId: string) {
    await transaction(async (tx) => {
      const metadata = await round(tx, roundId, false);
      const group = await context(tx, userId, metadata.group_id);
      if (!group || group.ownerId !== userId)
        throw ApiError.forbidden('Only the group owner can cancel this open round');
      const r = await round(tx, roundId);
      if (r.void_reason === 'OWNER_CANCELLED') return;
      if (r.state !== 'OPEN' || (await dbTime(tx)) >= r.closes_at)
        throw ApiError.conflict('Betting has closed. This round cannot be cancelled.');
      await freeze(
        tx,
        r,
        (await entries(tx, roundId)).filter((e) => e.state === 'ACCEPTED'),
        'OWNER_CANCELLED'
      );
      await flush(tx);
    });
    await recover(roundId);
  }
  async function recover(roundId: string) {
    // Freeze first, commit, then fetch entropy without holding account or wallet
    // locks. Every worker repeats validation before persisting the single draw.
    await transaction(async (tx) => {
      const metadata = await round(tx, roundId, false);
      if (options.practiceWorker && metadata.currency !== 'GAME_POINTS')
        throw new Error('Practice worker cannot process cash rounds');
      if (terminal(metadata)) return;
      const initial = (await entries(tx, roundId)).filter((e) => e.state === 'ACCEPTED');
      const group = await context(tx, null, metadata.group_id, {
        participants: initial.map((e) => e.user_id),
      });
      const r = await round(tx, roundId);
      if (r.state !== 'OPEN') return;
      const active = (await entries(tx, roundId)).filter((e) => e.state === 'ACCEPTED');
      if (active.some((e) => !initial.some((i) => i.user_id === e.user_id))) return;
      const now = await dbTime(tx);
      const closed = group && (group.status !== 'ACTIVE' || group.expiresAt <= now);
      if (!closed && now < r.closes_at) return;
      const reason = closed
        ? 'GROUP_CLOSED'
        : active.length < r.min_players
          ? 'NOT_ENOUGH_PLAYERS'
          : null;
      await freeze(tx, r, active, reason);
      await flush(tx);
    });
    const current = await transaction((tx) => round(tx, roundId, false));
    if (current.state === 'LOCKED') {
      if (Date.now() >= current.recovery_deadline.getTime()) {
        await transaction(async (tx) => {
          const r = await round(tx, roundId);
          if (r.state === 'LOCKED' && (await dbTime(tx)) >= r.recovery_deadline)
            await execute(
              tx,
              "UPDATE play_together_rounds SET state='DRAWN',void_reason='RESULT_UNAVAILABLE' WHERE id=$1",
              roundId
            );
          await flush(tx);
        });
      } else {
        const target = quicknetTargetForCutoff(current.closes_at);
        if (Date.now() < target.beaconTimeMs) return;
        const beacon = await fetchBeacon(current.closes_at.getTime());
        await verifyQuicknetBeacon(current.closes_at, beacon);
        await transaction(async (tx) => {
          const r = await round(tx, roundId);
          if (r.state !== 'LOCKED') return;
          if ((await dbTime(tx)) >= r.recovery_deadline) {
            await execute(
              tx,
              "UPDATE play_together_rounds SET state='DRAWN',void_reason='RESULT_UNAVAILABLE' WHERE id=$1",
              roundId
            );
            await flush(tx);
            return;
          }
          const active = (await entries(tx, roundId)).filter((e) =>
            r.locked_entry_ids!.includes(e.id)
          );
          if (
            togetherTermsHash(terms(r)) !== r.terms_hash ||
            togetherRosterHash(tickets(active)) !== r.roster_hash
          )
            throw new Error('Round commitment does not match');
          const proof = { seed: r.seed, beacon };
          const outcome = deriveTogetherOutcome(terms(r), tickets(active), proof);
          const ranking = rankTogether(r.game, tickets(active), outcome);
          const recording =
            r.presentation_version === 2
              ? preparePresentation(
                  r.game,
                  r.presentation_duration_ms!,
                  outcome,
                  tickets(active),
                  r.seed
                )
              : null;
          await execute(
            tx,
            "WITH schedule AS (SELECT date_trunc('milliseconds',clock_timestamp())+interval '5.001 seconds' AS start) " +
              "UPDATE play_together_rounds SET state='DRAWN',outcome=$2::jsonb,proof=$3::jsonb,ranking=$4::jsonb," +
              'presentation_starts_at=CASE WHEN presentation_version=2 THEN schedule.start END,' +
              "presentation_finishes_at=CASE WHEN presentation_version=2 THEN schedule.start+presentation_duration_ms*interval '1 millisecond' END," +
              'presentation_data=$5::jsonb FROM schedule WHERE id=$1',
            roundId,
            JSON.stringify(outcome),
            JSON.stringify(proof),
            JSON.stringify(ranking),
            recording ? JSON.stringify(recording) : null
          );
          await flush(tx);
        });
      }
    }
    await transaction(async (tx) => {
      const metadata = await round(tx, roundId, false);
      if (metadata.state !== 'DRAWN') return;
      if (
        metadata.presentation_finishes_at &&
        (await dbTime(tx)) < metadata.presentation_finishes_at
      )
        return;
      const initial = (await entries(tx, roundId)).filter((e) =>
        metadata.locked_entry_ids!.includes(e.id)
      );
      await context(tx, null, metadata.group_id, { participants: initial.map((e) => e.user_id) });
      const r = await round(tx, roundId);
      if (r.state !== 'DRAWN') return;
      if (r.presentation_finishes_at && (await dbTime(tx)) < r.presentation_finishes_at) return;
      const active = (await entries(tx, roundId)).filter((e) => r.locked_entry_ids!.includes(e.id));
      if (active.some((e) => e.state !== 'ACCEPTED'))
        throw new Error('Group settlement has an unexpected entry state');
      if (togetherRosterHash(tickets(active)) !== r.roster_hash)
        throw new Error('Locked group roster differs');
      if (r.outcome) {
        if (!r.proof) throw new Error('Group draw has no verification proof');
        await verifyQuicknetBeacon(r.closes_at, r.proof.beacon);
        const expected = deriveTogetherOutcome(terms(r), tickets(active), r.proof);
        if (canonicalJson(expected) !== canonicalJson(r.outcome))
          throw new Error('Stored outcome does not verify');
      }
      const ranking = r.outcome
        ? rankTogether(r.game, tickets(active), r.outcome)
        : active.map((e) => ({ entryId: e.id, score: 0, detail: 'Refund' }));
      const settlement = settleTogether(r.entry_amount, r.fee_bps, ranking, r.id, r.void_reason);
      await lockWallets(tx, active);
      for (const e of active)
        await payEntry(
          tx,
          r,
          e,
          settlement.payouts.find((p) => p.entryId === e.id)!.amount,
          settlement.refunds
        );
      await execute(
        tx,
        'UPDATE play_together_rounds SET state=$2,settlement=$3::jsonb,funded=$4,platform_fee=$5,paid_at=clock_timestamp(),retry_after=NULL WHERE id=$1',
        r.id,
        settlement.refunds ? 'REFUNDED' : 'PAID',
        JSON.stringify(settlement),
        settlement.funded,
        settlement.platformFee
      );
      await flush(tx);
    });
  }
  async function snapshot(userId: string, roundId: string): Promise<TogetherSnapshot> {
    return transaction(async (tx) => {
      const metadata = await round(tx, roundId, false);
      const group = await context(tx, userId, metadata.group_id, { read: true, roundId });
      const r = await round(tx, roundId),
        all = await entries(tx, roundId);
      const s = await policy(tx),
        now = await dbTime(tx);
      const resultAvailable =
        r.presentation_version !== 2 ||
        (!!r.presentation_finishes_at && now >= r.presentation_finishes_at);
      const [stream] = await rows<{ revision: number; sequence: bigint }>(
        tx,
        'SELECT COALESCE(s.revision,0)::int AS revision,COALESCE((SELECT max(e.sequence) FROM play_together_events e WHERE e.round_id=$1 AND e.available_at<=$2),0)::bigint AS sequence FROM play_together_rounds r LEFT JOIN play_together_streams s ON s.round_id=r.id WHERE r.id=$1',
        roundId,
        now
      );
      const view: TogetherRoundView = {
        ...terms(r),
        revision: stream.revision,
        eventSequence: Number(stream.sequence),
        ...(r.presentation_version === 2 && r.presentation_starts_at && r.presentation_finishes_at
          ? {
              presentation: {
                version: 2 as const,
                startsAt: r.presentation_starts_at.getTime(),
                finishesAt: r.presentation_finishes_at.getTime(),
                observedAt: now.getTime(),
                events: (r.presentation_data ?? []).filter(
                  (e) => e.atMs <= now.getTime() - r.presentation_starts_at!.getTime()
                ),
                resultAvailable,
              },
            }
          : {}),
        creatorId: r.creator_id,
        groupName: group?.name ?? null,
        state: r.state,
        termsHash: r.terms_hash,
        rosterHash: r.roster_hash,
        entries: all.map((e) => ({
          id: e.id,
          userId: e.user_id,
          username: e.username,
          selection: r.state !== 'OPEN' || e.user_id === userId ? e.selection : null,
          state: e.state,
          amount: e.amount,
          payout: e.payout,
          createdAt: e.created_at.getTime(),
          walletTransactionId: e.user_id === userId ? e.hold_transaction_id : '',
          payoutTransactionId: e.user_id === userId ? e.payout_transaction_id : null,
          requestId: e.user_id === userId ? e.request_id : null,
        })),
        outcome: resultAvailable ? r.outcome : null,
        ranking: resultAvailable ? (r.ranking ?? []) : [],
        settlement: r.settlement,
        voidReason: r.void_reason,
        proof: resultAvailable ? r.proof : null,
        recoveryDeadline: r.recovery_deadline.getTime(),
        paidAt: r.paid_at?.getTime() ?? null,
      };
      return {
        serverTime: now.getTime(),
        workerReady: await ready(),
        admissionsEnabled: env.PLAY_TOGETHER_ENABLED !== 'false',
        settings: s,
        balances: await balances(tx, userId),
        cashAvailable: !!(await cashAdmission(tx, userId, s)),
        round: view,
      };
    });
  }
  async function lobby(userId: string, groupId?: string) {
    return transaction(async (tx) => {
      const group = await context(tx, userId, groupId ?? null, { read: true });
      const s = await policy(tx);
      const groups = await rows<{ id: string; name: string; ownerId: string }>(
        tx,
        'SELECT g.id,g.name,g."ownerId" FROM groups g JOIN group_members m ON m."groupId"=g.id WHERE m."userId"=$1 AND m.status IN (\'ACTIVE\',\'MUTED\') AND g.status=\'ACTIVE\' AND g."expiresAt">clock_timestamp() ORDER BY g.name LIMIT 50',
        userId
      );
      const list = await rows<{
        id: string;
        groupId: string | null;
        groupName: string | null;
        game: TogetherGame;
        currency: TogetherCurrency;
        entryAmount: number;
        feeBps: number;
        state: string;
        closesAt: Date;
        participants: number;
        createdAt: Date;
      }>(
        tx,
        'SELECT r.id,r.group_id AS "groupId",g.name AS "groupName",r.game,r.currency,r.entry_amount AS "entryAmount",r.fee_bps AS "feeBps",r.state,r.closes_at AS "closesAt",r.created_at AS "createdAt",' +
          "(SELECT count(*)::int FROM play_together_entries e WHERE e.round_id=r.id AND (e.state<>'REFUNDED' OR e.id=ANY(r.locked_entry_ids))) AS participants " +
          'FROM play_together_rounds r LEFT JOIN groups g ON g.id=r.group_id WHERE ($2::text IS NULL OR r.group_id=$2) AND ' +
          "((r.group_id IS NULL AND r.state IN ('OPEN','LOCKED','DRAWN')) OR EXISTS(SELECT 1 FROM group_members m WHERE m.\"groupId\"=r.group_id AND m.\"userId\"=$1 AND m.status IN ('ACTIVE','MUTED')) OR EXISTS(SELECT 1 FROM play_together_entries e WHERE e.round_id=r.id AND e.user_id=$1)) " +
          "ORDER BY CASE WHEN r.state IN ('OPEN','LOCKED','DRAWN') THEN 0 ELSE 1 END,r.paid_at DESC NULLS FIRST,r.created_at DESC,r.id DESC LIMIT 50",
        userId,
        groupId ?? null
      );
      const legacyPending = groupId
        ? (
            await rows(
              tx,
              "SELECT id FROM group_pvp_rounds WHERE group_id=$1 AND state IN ('OPEN','COUNTDOWN','DRAWN') LIMIT 1",
              groupId
            )
          ).length > 0
        : false;
      return {
        serverTime: (await dbTime(tx)).getTime(),
        workerReady: await ready(),
        admissionsEnabled: env.PLAY_TOGETHER_ENABLED !== 'false',
        settings: s,
        group,
        groups,
        balances: await balances(tx, userId),
        cashAvailable: !!(await cashAdmission(tx, userId, s)),
        rounds: list.map((r) => ({
          ...r,
          closesAt: r.closesAt.getTime(),
          createdAt: r.createdAt.getTime(),
        })),
        legacyPending,
      };
    });
  }
  async function activity(userId: string, groupId: string): Promise<TogetherGroupActivity> {
    return transaction(async (tx) => {
      const group = await context(tx, userId, groupId, { read: true });
      if (!group) throw ApiError.notFound('Group not found');
      const list = await rows<
        Omit<TogetherActivityRound, 'closesAt' | 'groupName'> & { closesAt: Date }
      >(
        tx,
        "SELECT DISTINCT ON ((r.state IN ('OPEN','LOCKED','DRAWN'))) " +
          'r.id,r.game,r.currency,r.entry_amount AS "entryAmount",r.state,r.closes_at AS "closesAt",' +
          '(SELECT count(*)::int FROM play_together_entries e WHERE e.round_id=r.id AND ' +
          "(e.state<>'REFUNDED' OR e.id=ANY(r.locked_entry_ids))) AS participants " +
          'FROM play_together_rounds r WHERE r.group_id=$1 ' +
          "ORDER BY (r.state IN ('OPEN','LOCKED','DRAWN')) DESC,r.paid_at DESC NULLS FIRST,r.created_at DESC,r.id DESC",
        groupId
      );
      const summarize = (value: (typeof list)[number] | undefined): TogetherActivityRound | null =>
        value ? { ...value, closesAt: value.closesAt.getTime(), groupName: group.name } : null;
      return {
        serverTime: (await dbTime(tx)).getTime(),
        activeRound: summarize(
          list.find((value) => ['OPEN', 'LOCKED', 'DRAWN'].includes(value.state))
        ),
        latestResult: summarize(list.find((value) => ['PAID', 'REFUNDED'].includes(value.state))),
      };
    });
  }
  async function settings(userId: string, update?: TogetherSettings) {
    return transaction(async (tx) => {
      await lockUserEconomicScope(tx, 'together-policy');
      const [actor] = await rows<{ role: string; status: string }>(
        tx,
        'SELECT role::text,status::text FROM users WHERE id=$1 FOR SHARE',
        userId
      );
      if (!actor || actor.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(actor.role))
        throw ApiError.forbidden('Administrator access is required');
      const s = await policy(tx);
      if (!update) return s;
      if (update.version !== s.version)
        throw ApiError.conflict('Settings were updated elsewhere. Reload before saving.');
      if (
        !Number.isInteger(update.feeBps) ||
        update.feeBps < 0 ||
        update.feeBps > 2000 ||
        !Number.isInteger(update.minEntry) ||
        update.minEntry < 100 ||
        update.minEntry % 100 ||
        !Number.isInteger(update.maxEntry) ||
        update.maxEntry < update.minEntry ||
        update.maxEntry > 100000 ||
        update.maxEntry % 100 ||
        !Array.isArray(update.enabledGames) ||
        !update.enabledGames.length ||
        new Set(update.enabledGames).size !== update.enabledGames.length ||
        update.enabledGames.some((g) => !TOGETHER_GAMES.some((known) => known.key === g)) ||
        ['practiceEnabled', 'cashEnabled', 'publicRoomsEnabled'].some(
          (key) => typeof update[key as keyof typeof update] !== 'boolean'
        )
      )
        throw ApiError.badRequest('Invalid platform group settings');
      if (update.cashEnabled && env.PLAY_TOGETHER_CASH_ENABLED !== 'true')
        throw ApiError.forbidden('Cash group play must be prepared before it can be enabled');
      await execute(
        tx,
        'INSERT INTO play_together_policies(version,fee_bps,min_entry,max_entry,enabled_games,practice_enabled,cash_enabled,public_rooms_enabled,changed_by) VALUES($1,$2,$3,$4,$5::text[],$6,$7,$8,$9)',
        s.version + 1,
        update.feeBps,
        update.minEntry,
        update.maxEntry,
        update.enabledGames,
        update.practiceEnabled,
        update.cashEnabled,
        update.publicRoomsEnabled,
        userId
      );
      return policy(tx);
    });
  }
  async function operations(userId: string) {
    await settings(userId);
    return transaction((tx) =>
      rows<{
        id: string;
        game: string;
        currency: string;
        state: string;
        closes_at: Date;
        funded: number | null;
        platform_fee: number | null;
        void_reason: string | null;
      }>(
        tx,
        "SELECT id,game,currency,state,closes_at,funded,platform_fee,void_reason FROM play_together_rounds ORDER BY CASE WHEN state IN ('LOCKED','DRAWN') THEN 0 ELSE 1 END,created_at DESC LIMIT 100"
      )
    );
  }
  async function refillPractice(userId: string) {
    return transaction(async (tx) => {
      await lockUserEconomicScope(tx, 'together-practice:' + userId);
      await context(tx, userId, null);
      const s = await policy(tx);
      if (!s.practiceEnabled || env.PLAY_TOGETHER_ENABLED === 'false')
        throw ApiError.forbidden('Practice group play is paused');
      const day = (await dbTime(tx)).toISOString().slice(0, 10);
      const referenceId = 'together-practice:' + day;
      await getOrCreateWallet(userId, tx);
      await rows(tx, 'SELECT id FROM wallets WHERE "userId"=$1 FOR UPDATE', userId);
      const previous = await tx.walletTransaction.findFirst({
        where: { userId, currency: 'GAME_POINTS', referenceType: 'GAME', referenceId },
        select: { id: true },
      });
      const b = await balances(tx, userId);
      const amount = previous ? 0 : Math.max(0, 10000 - b.pointsAvailable - b.pointsReserved);
      if (amount)
        await applyBalanceChanges(tx, userId, [
          {
            currency: 'GAME_POINTS',
            amount,
            ledgerType: 'CREDIT',
            transactionType: 'GAME_POINT_CREDIT',
            referenceType: 'GAME',
            referenceId,
            description: 'Daily group practice refill — no cash value',
          },
        ]);
      await flush(tx);
      return {
        added: amount,
        balance: b.pointsAvailable + amount,
        nextRefillAt: new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString(),
      };
    });
  }
  async function tick() {
    await runTogetherJobs(db, recover, workerId, options.practiceWorker);
  }
  return {
    create,
    openPublic,
    enter,
    withdraw,
    cancel,
    recover,
    snapshot,
    lobby,
    activity,
    settings,
    operations,
    health: () => togetherJobHealth(db),
    refillPractice,
    tick,
  };
}
