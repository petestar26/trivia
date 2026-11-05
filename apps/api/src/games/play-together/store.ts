import type { Prisma } from '@socialplay/database';
import type {
  TogetherCurrency,
  TogetherGame,
  TogetherOutcome,
  TogetherProof,
  TogetherRanking,
  TogetherSettlement,
  TogetherSettings,
  TogetherState,
  TogetherTerms,
} from '@socialplay/shared';
import { TOGETHER_RULES_ID, TOGETHER_FEE_POLICY } from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';

export type Tx = Prisma.TransactionClient;
/** SQL text is server-owned; all runtime values remain bound parameters. */
export const rows = <T>(tx: Tx, sql: string, ...values: unknown[]) =>
  tx.$queryRawUnsafe<T[]>(sql, ...values);
export const execute = (tx: Tx, sql: string, ...values: unknown[]) =>
  tx.$executeRawUnsafe(sql, ...values);
export interface RoundRow {
  id: string;
  group_id: string | null;
  creator_id: string | null;
  request_id: string;
  request_hash: string;
  game: TogetherGame;
  currency: TogetherCurrency;
  entry_amount: number;
  fee_bps: number;
  policy_version: number;
  rules_id: typeof TOGETHER_RULES_ID;
  min_players: number;
  max_players: number;
  created_at: Date;
  closes_at: Date;
  recovery_deadline: Date;
  seed: string;
  seed_commitment: string;
  terms_hash: string;
  beacon_round: bigint;
  state: TogetherState;
  locked_at: Date | null;
  locked_entry_ids: string[] | null;
  roster_hash: string | null;
  outcome: TogetherOutcome | null;
  proof: TogetherProof | null;
  ranking: TogetherRanking[] | null;
  void_reason: string | null;
  settlement: TogetherSettlement | null;
  funded: number | null;
  platform_fee: number | null;
  paid_at: Date | null;
  retry_after: Date | null;
}
export interface EntryRow {
  id: string;
  round_id: string;
  user_id: string;
  username: string;
  request_id: string;
  selection: number[];
  amount: number;
  state: 'ACCEPTED' | 'REFUNDED' | 'SETTLED';
  policy_id: string | null;
  policy_version: number | null;
  hold_operation_id: string | null;
  hold_transaction_id: string;
  close_operation_id: string | null;
  prize_operation_id: string | null;
  payout_transaction_id: string | null;
  payout: number | null;
  created_at: Date;
  closed_at: Date | null;
}
export const dbTime = async (tx: Tx) =>
  (await rows<{ now: Date }>(tx, 'SELECT clock_timestamp() AS now'))[0].now;
export async function policy(tx: Tx): Promise<TogetherSettings> {
  const [p] = await rows<{
    version: number;
    fee_bps: number;
    min_entry: number;
    max_entry: number;
    enabled_games: TogetherGame[];
    practice_enabled: boolean;
    cash_enabled: boolean;
    public_rooms_enabled: boolean;
  }>(tx, 'SELECT * FROM play_together_policies ORDER BY version DESC LIMIT 1');
  if (!p) throw ApiError.serviceUnavailable('Group play is being prepared');
  return {
    version: p.version,
    feeBps: p.fee_bps,
    minEntry: p.min_entry,
    maxEntry: p.max_entry,
    enabledGames: p.enabled_games,
    practiceEnabled: p.practice_enabled,
    cashEnabled: p.cash_enabled,
    publicRoomsEnabled: p.public_rooms_enabled,
  };
}
export function terms(r: RoundRow): TogetherTerms {
  return {
    id: r.id,
    groupId: r.group_id,
    game: r.game,
    currency: r.currency,
    entryAmount: r.entry_amount,
    feeBps: r.fee_bps,
    settingsVersion: r.policy_version,
    minPlayers: r.min_players,
    maxPlayers: r.max_players,
    closesAt: r.closes_at.getTime(),
    rulesId: r.rules_id,
    feePolicy: TOGETHER_FEE_POLICY,
    seedCommitment: r.seed_commitment,
    beaconRound: Number(r.beacon_round),
  };
}
export async function round(tx: Tx, id: string, lock = true): Promise<RoundRow> {
  const [r] = await rows<RoundRow>(
    tx,
    'SELECT * FROM play_together_rounds WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
    id
  );
  if (!r) throw ApiError.notFound('Round not found');
  return r;
}
export const entries = (tx: Tx, id: string) =>
  rows<EntryRow>(
    tx,
    'SELECT e.*,u.username FROM play_together_entries e JOIN users u ON u.id=e.user_id WHERE e.round_id=$1 ORDER BY e.id',
    id
  );
export const tickets = (list: EntryRow[]) =>
  list.map((e) => ({ id: e.id, userId: e.user_id, selection: e.selection }));

/** Keep the same admission ordering as group moderation and legacy group play. */
export async function context(
  tx: Tx,
  actorId: string | null,
  groupId: string | null,
  options: { refund?: boolean; read?: boolean; roundId?: string; participants?: string[] } = {}
) {
  const ids = [...new Set([...(actorId ? [actorId] : []), ...(options.participants ?? [])])].sort();
  const accounts = await rows<{ id: string; status: string }>(
    tx,
    'SELECT id,status::text FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',
    ids
  );
  if (
    actorId &&
    (!accounts.some((a) => a.id === actorId) ||
      (!options.refund &&
        !options.read &&
        accounts.find((a) => a.id === actorId)?.status !== 'ACTIVE'))
  )
    throw ApiError.forbidden('An active account is required');
  if (!groupId) return null;
  const [group] = await rows<{
    id: string;
    name: string;
    ownerId: string;
    status: string;
    expiresAt: Date;
  }>(
    tx,
    'SELECT id,name,"ownerId",status::text,"expiresAt" FROM groups WHERE id=$1 FOR NO KEY UPDATE',
    groupId
  );
  if (!group) throw ApiError.notFound('Group not found');
  if (actorId && !options.refund) {
    const [member] = await rows<{ status: string }>(
      tx,
      'SELECT status::text FROM group_members WHERE "groupId"=$1 AND "userId"=$2 FOR SHARE',
      groupId,
      actorId
    );
    if (!member || !['ACTIVE', 'MUTED'].includes(member.status)) {
      const prior =
        options.read && options.roundId
          ? await rows(
              tx,
              'SELECT id FROM play_together_entries WHERE round_id=$1 AND user_id=$2 LIMIT 1',
              options.roundId,
              actorId
            )
          : [];
      if (!prior.length) throw ApiError.forbidden('Join this group to access its games');
    }
  }
  return group;
}
