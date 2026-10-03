import { randomInt, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@socialplay/database';
import { GROUP_PVP_RULES, validatePvpSelection, pvpWinnerIds, type GroupPvpGame, type GroupPvpSnapshot } from '@socialplay/shared';
import { applyBalanceChanges } from '../../economy/wallet-service.js';
import { ApiError } from '../../middleware/api-error.js';
import { planContestSettlement } from '../economics/contest-pool.js';
import { PVP_POLICY } from '../economics/policy.js';

type Tx = Prisma.TransactionClient;
interface Round {
  id: string; group_id: string; creator_id: string; request_id: string;
  game: GroupPvpGame; entry_amount: number; rules_id: string; policy_id: typeof PVP_POLICY;
  state: 'OPEN' | 'COUNTDOWN' | 'DRAWN' | 'SETTLED' | 'VOID';
  expires_at: Date; starts_at: Date | null; outcome: number[] | null;
  void_reason: string | null; settlement: NonNullable<GroupPvpSnapshot['round']>['settlement'];
}
interface Entry { id: string; user_id: string; username: string; state: 'JOINED' | 'READY' | 'WITHDRAWN'; selection: number[] | null; debit_id: string | null; refund_id: string | null }
interface Group { id: string; name: string; ownerId: string; status: string }

export function createGroupPvpService(db: PrismaClient) {
  const clock = async (tx: Tx) => (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  const entries = (tx: Tx, roundId: string) => tx.$queryRaw<Entry[]>`SELECT * FROM group_pvp_entries WHERE round_id=${roundId} ORDER BY user_id`;
  const round = async (tx: Tx, groupId: string, roundId: string) => {
    const [r] = await tx.$queryRaw<Round[]>`SELECT * FROM group_pvp_rounds WHERE id=${roundId} AND group_id=${groupId} FOR UPDATE`;
    if (!r) throw ApiError.notFound('Game round not found');
    return r;
  };
  // Lock order: sorted users -> group -> memberships -> round -> entries -> wallets.
  // The group NO KEY UPDATE lock serializes all PVP actions with group moderation.
  async function access(tx: Tx, groupId: string, actorId: string, participantIds: string[] = []) {
    const ids = [...new Set([actorId, ...participantIds])].sort();
    const accounts = await tx.$queryRaw<{ id: string; status: string; isVerified: boolean }[]>`
      SELECT id,status::text,"isVerified" FROM users WHERE id=ANY(${ids}::text[]) ORDER BY id FOR SHARE`;
    const actor = accounts.find(a => a.id === actorId);
    if (!actor || actor.status !== 'ACTIVE' || !actor.isVerified) throw ApiError.forbidden('An active verified account is required');
    const [g] = await tx.$queryRaw<Group[]>`SELECT id,name,"ownerId",status::text FROM groups WHERE id=${groupId} FOR NO KEY UPDATE`;
    if (!g) throw ApiError.notFound('Group not found');
    const members = await tx.$queryRaw<{ userId: string; status: string }[]>`
      SELECT "userId",status::text FROM group_members WHERE "groupId"=${groupId} AND "userId"=ANY(${ids}::text[]) ORDER BY id FOR SHARE`;
    if (!members.some(m => m.userId === actorId && m.status === 'ACTIVE')) throw ApiError.forbidden('Join this group to access its games');
    return { group: g, accounts, members };
  }
  function owner(g: Group, actorId: string) {
    if (g.ownerId !== actorId || g.status !== 'ACTIVE') throw ApiError.forbidden('Only the active group owner can control this round');
  }
  function open(r: Round, now: Date) {
    if (r.state !== 'OPEN' || now >= r.expires_at) throw ApiError.conflict('Entries are locked for this round');
  }
  async function money(tx: Tx, userId: string, amount: number, credit: boolean, referenceId: string) {
    // The wallet helper is the existing authoritative Game Point journal writer.
    const result = await applyBalanceChanges(tx, userId, [{ currency: 'GAME_POINTS', amount,
      ledgerType: credit ? 'CREDIT' : 'DEBIT', transactionType: credit ? 'GAME_POINT_CREDIT' : 'GAME_POINT_DEBIT',
      referenceType: 'GAME', referenceId, description: credit ? 'Group PVP award or full refund' : 'Group PVP confirmed entry' }]);
    return result.transactions[0].id as string;
  }
  async function lockWallets(tx: Tx, ids: string[]) {
    await tx.$queryRaw`SELECT id FROM wallets WHERE "userId"=ANY(${[...new Set(ids)].sort()}::text[]) ORDER BY id FOR UPDATE`;
  }
  async function snapshot(groupId: string, actorId: string): Promise<GroupPvpSnapshot> {
    return db.$transaction(async tx => {
      const { group: g } = await access(tx, groupId, actorId);
      const [r] = await tx.$queryRaw<Round[]>`SELECT * FROM group_pvp_rounds WHERE group_id=${groupId} ORDER BY created_at DESC,id DESC LIMIT 1`;
      const wallet = await tx.wallet.findUnique({ where: { userId: actorId } });
      const items = r ? (await entries(tx, r.id)).filter(e => e.state !== 'WITHDRAWN') : [];
      return { enabled: g.status === 'ACTIVE', currency: 'GAME_POINTS', serverTime: (await clock(tx)).getTime(),
        groupName: g.name, ownerId: g.ownerId, balance: wallet?.gamePointsBalance ?? 0,
        round: r ? { id: r.id, creationRequestId: r.request_id, game: r.game, entryAmount: r.entry_amount, policyId: r.policy_id, rulesId: r.rules_id,
          state: r.state, expiresAt: r.expires_at.getTime(), startsAt: r.starts_at?.getTime() ?? null,
          outcome: r.outcome, settlement: r.settlement,
          entries: items.map(e => ({ userId: e.user_id, username: e.username, ready: e.state === 'READY',
            selection: e.user_id === actorId || r.state !== 'OPEN' ? e.selection : null })) } : null };
    });
  }
  async function create(groupId: string, actorId: string, game: GroupPvpGame, amount: number, requestId: string) {
    if (!['spin_win','turbo_keno'].includes(game) || !Number.isSafeInteger(amount) || amount < 100 || amount > 10000 || amount % 100 ||
        !/^[0-9a-f-]{36}$/.test(requestId)) throw ApiError.badRequest('Choose a game and an entry in steps of 100 Game Points');
    return db.$transaction(async tx => {
      const { group: g } = await access(tx, groupId, actorId); owner(g, actorId);
      const [existing] = await tx.$queryRaw<Round[]>`SELECT * FROM group_pvp_rounds WHERE creator_id=${actorId} AND request_id=${requestId}`;
      if (existing) {
        if (existing.group_id !== groupId || existing.game !== game || existing.entry_amount !== amount) throw ApiError.conflict('Creation request has changed');
        return existing.id;
      }
      const active = await tx.$queryRaw`SELECT id FROM group_pvp_rounds WHERE group_id=${groupId} AND state IN ('OPEN','COUNTDOWN','DRAWN')`;
      if ((active as unknown[]).length) throw ApiError.conflict('Finish the current game first');
      const id = randomUUID(); const now = await clock(tx);
      await tx.$executeRaw`INSERT INTO group_pvp_rounds(id,group_id,creator_id,request_id,game,rules_id,policy_id,entry_amount,expires_at)
        VALUES(${id},${groupId},${actorId},${requestId},${game},${GROUP_PVP_RULES.id},${PVP_POLICY},${amount},${new Date(now.getTime()+GROUP_PVP_RULES.lobbyMs)})`;
      return id;
    });
  }
  async function join(groupId: string, actorId: string, roundId: string) {
    await db.$transaction(async tx => {
      const { group: g } = await access(tx, groupId, actorId);
      if (g.status !== 'ACTIVE') throw ApiError.forbidden('Group is not active');
      const r = await round(tx, groupId, roundId); open(r, await clock(tx));
      const items = await entries(tx, roundId); const previous = items.find(e => e.user_id === actorId);
      if (previous?.state === 'WITHDRAWN') throw ApiError.conflict('You left this round; join the next one');
      if (previous) return;
      if (items.filter(e => e.state !== 'WITHDRAWN').length >= GROUP_PVP_RULES.maxPlayers) throw ApiError.conflict('Round is full');
      const user = await tx.user.findUniqueOrThrow({ where: { id: actorId }, select: { username: true } });
      await tx.$executeRaw`INSERT INTO group_pvp_entries(id,round_id,user_id,username) VALUES(${randomUUID()},${roundId},${actorId},${user.username})`;
    });
  }
  async function ready(groupId: string, actorId: string, roundId: string, selection: unknown, policyId: string, amount: number) {
    await db.$transaction(async tx => {
      const { group: g } = await access(tx, groupId, actorId);
      if (g.status !== 'ACTIVE') throw ApiError.forbidden('Group is not active');
      const r = await round(tx, groupId, roundId);
      if (policyId !== r.policy_id || amount !== r.entry_amount) throw ApiError.conflict('Entry terms changed; review them again');
      let picks: number[]; try { picks = validatePvpSelection(r.game, selection); } catch (e) { throw ApiError.badRequest((e as Error).message); }
      const entry = (await entries(tx, roundId)).find(e => e.user_id === actorId);
      if (entry?.state === 'READY' && JSON.stringify(entry.selection) === JSON.stringify(picks)) return;
      open(r, await clock(tx));
      if (!entry || entry.state !== 'JOINED') throw ApiError.conflict('Join this round before confirming your entry');
      await lockWallets(tx, [actorId]);
      open(r, await clock(tx));
      const debitId = await money(tx, actorId, r.entry_amount, false, entry.id);
      // A delayed journal write must also roll back if the admission deadline passed.
      open(r, await clock(tx));
      await tx.$executeRaw`UPDATE group_pvp_entries SET state='READY', selection=${JSON.stringify(picks)}::jsonb,debit_id=${debitId} WHERE id=${entry.id}`;
    });
  }
  async function withdraw(groupId: string, actorId: string, roundId: string) {
    await db.$transaction(async tx => {
      await access(tx, groupId, actorId);
      const r = await round(tx, groupId, roundId); const entry = (await entries(tx, roundId)).find(e => e.user_id === actorId);
      if (!entry || entry.state === 'WITHDRAWN') return;
      open(r, await clock(tx));
      let refundId: string | null = null;
      if (entry.state === 'READY') { await lockWallets(tx,[actorId]); refundId = await money(tx, actorId, r.entry_amount, true, entry.id); }
      await tx.$executeRaw`UPDATE group_pvp_entries SET state='WITHDRAWN',refund_id=${refundId} WHERE id=${entry.id}`;
    });
  }
  async function start(groupId: string, actorId: string, roundId: string) {
    // Snapshot IDs only for lock ordering; all state and eligibility is reread under locks.
    const candidates = await db.$queryRaw<{ user_id: string }[]>`SELECT user_id FROM group_pvp_entries WHERE round_id=${roundId} AND state<>'WITHDRAWN'`;
    const ids = candidates.map(e => e.user_id);
    await db.$transaction(async tx => {
      const { group: g, accounts, members } = await access(tx, groupId, actorId, ids); owner(g, actorId);
      const r = await round(tx, groupId, roundId);
      if (r.state === 'COUNTDOWN' || r.state === 'DRAWN' || r.state === 'SETTLED') return;
      open(r, await clock(tx));
      const players = (await entries(tx, roundId)).filter(e => e.state !== 'WITHDRAWN');
      if (players.length < 2 || players.some(e => e.state !== 'READY')) throw ApiError.conflict('At least two players must join and everyone must confirm their entry');
      if (players.some(e => !ids.includes(e.user_id))) throw ApiError.conflict('Players changed; retry start');
      if (players.some(e => !accounts.some(a => a.id === e.user_id && a.status === 'ACTIVE' && a.isVerified) ||
          !members.some(m => m.userId === e.user_id && m.status === 'ACTIVE'))) throw ApiError.conflict('A player is no longer eligible; cancel this round for a full refund');
      const now = await clock(tx); open(r, now);
      await tx.$executeRaw`UPDATE group_pvp_rounds SET state='COUNTDOWN',starts_at=${new Date(now.getTime()+GROUP_PVP_RULES.countdownMs)} WHERE id=${roundId}`;
    });
  }
  async function cancel(groupId: string, actorId: string, roundId: string) {
    await db.$transaction(async tx => {
      const { group: g } = await access(tx, groupId, actorId); owner(g, actorId);
      const r = await round(tx, groupId, roundId);
      if (r.state === 'VOID' || r.void_reason === 'OWNER_CANCELLED') return;
      if (r.state !== 'OPEN') throw ApiError.conflict('A started round cannot be cancelled');
      await tx.$executeRaw`UPDATE group_pvp_rounds SET state='DRAWN',void_reason='OWNER_CANCELLED' WHERE id=${roundId}`;
    });
    await recoverOne(groupId, roundId);
  }
  async function recoverOne(groupId: string, roundId: string) {
    // Persist the outcome BEFORE attempting any payout. A failed credit leaves a durable DRAWN obligation.
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM groups WHERE id=${groupId} FOR NO KEY UPDATE`;
      const r = await round(tx, groupId, roundId); const now = await clock(tx);
      if (r.state === 'OPEN' && now >= r.expires_at) {
        await tx.$executeRaw`UPDATE group_pvp_rounds SET state='DRAWN',void_reason='LOBBY_EXPIRED' WHERE id=${roundId}`;
      } else if (r.state === 'COUNTDOWN' && r.starts_at && now >= r.starts_at) {
        const values = Array.from({length:r.game === 'spin_win' ? 37 : 80},(_,i)=>i+(r.game === 'spin_win' ? 0 : 1));
        const count = r.game === 'spin_win' ? 1 : 20;
        for(let i=0;i<count;i++){const j=randomInt(i,values.length);[values[i],values[j]]=[values[j],values[i]];}
        await tx.$executeRaw`UPDATE group_pvp_rounds SET state='DRAWN',outcome=${JSON.stringify(values.slice(0,count))}::jsonb WHERE id=${roundId}`;
      }
    });
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM groups WHERE id=${groupId} FOR NO KEY UPDATE`;
      const r = await round(tx, groupId, roundId); if (r.state !== 'DRAWN') return;
      const paid = (await entries(tx, roundId)).filter(e => e.state === 'READY');
      for (const entry of paid) {
        const receipt = await tx.walletTransaction.findUnique({ where: { id: entry.debit_id! } });
        if (!receipt || receipt.userId !== entry.user_id || receipt.currency !== 'GAME_POINTS' || receipt.ledgerType !== 'DEBIT' ||
            receipt.amount !== r.entry_amount || receipt.referenceId !== entry.id) throw new Error('PVP funding receipt mismatch');
      }
      const winners = r.outcome ? pvpWinnerIds(r.game, paid.map(e=>({userId:e.user_id,selection:e.selection!})),r.outcome) : [];
      const plan = planContestSettlement({policy:r.policy_id,currency:'GAME_POINTS',contributions:paid.map(e=>({id:e.debit_id!,userId:e.user_id,kind:'ENTRY',amount:BigInt(r.entry_amount)}))},
        winners.length ? {status:'COMPLETED',winnerIds:winners} : {status:'VOID'});
      const credits = new Map<string,number>();
      for(const credit of [...plan.prizes,...plan.refunds]) credits.set(credit.userId,(credits.get(credit.userId)??0)+Number(credit.amount));
      await lockWallets(tx,[...credits.keys()]);
      for(const [userId,amount] of [...credits].sort(([a],[b])=>a.localeCompare(b))) await money(tx,userId,amount,true,roundId);
      const settlement = { platformFee:Number(plan.platformFee),
        prizes:plan.prizes.map(p=>({userId:p.userId,username:paid.find(e=>e.user_id===p.userId)!.username,amount:Number(p.amount)})),
        refunds:plan.refunds.map(p=>({userId:p.userId,amount:Number(p.amount)})),reason:r.void_reason??(winners.length ? null : 'NO_WINNER') };
      await tx.$executeRaw`UPDATE group_pvp_rounds SET state=${winners.length ? 'SETTLED' : 'VOID'},settlement=${JSON.stringify(settlement)}::jsonb WHERE id=${roundId}`;
    });
  }
  async function tick(onError: (roundId: string, error: unknown) => void = () => {}) {
    const due = await db.$queryRaw<{id:string;group_id:string}[]>`SELECT id,group_id FROM group_pvp_rounds
      WHERE retry_at<=clock_timestamp() AND (state='DRAWN' OR (state='COUNTDOWN' AND starts_at<=clock_timestamp()) OR (state='OPEN' AND expires_at<=clock_timestamp()))
      ORDER BY retry_at,created_at LIMIT 50`;
    for(const r of due) try {
      // Persist backoff before work so failing obligations cannot monopolize every batch.
      await db.$executeRaw`UPDATE group_pvp_rounds SET retry_at=clock_timestamp()+interval '30 seconds' WHERE id=${r.id} AND state IN ('OPEN','COUNTDOWN','DRAWN')`;
      await recoverOne(r.group_id,r.id);
    } catch(error) { onError(r.id,error); }
  }
  return { snapshot, create, join, ready, withdraw, start, cancel, tick, recoverOne };
}
