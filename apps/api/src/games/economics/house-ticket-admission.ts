import type { PrismaClient } from '@prisma/client';
import { parseSpin90Bets, SPIN90_RULES_ID } from '@socialplay/shared';
import { ApiError } from '../../middleware/error-handler.js';
import { lockUserForPlay, lockGameForPlay } from '../game-locks.js';
import { requirePlatformGate, requirePlayableJurisdiction, resolveJurisdictionForPlay } from '../../economy/jurisdiction-service.js';
import { reserveScheduledStakeCoins } from '../../economy/coin-ledger-service.js';
import { emptyHouseBook, quoteHouseAdmission } from './house-risk.js';
import { quoteSpin90Ticket } from './models.js';
import { identifier, total } from './money.js';

/**
 * Owner-only internal proof of atomic admission. No HTTP route or worker calls
 * this. The API runtime credential cannot execute the capital function.
 * Every ticket reserves its own worst-case loss; this is conservative when
 * different players back opposing outcomes. No settlement/release exists.
 */
export async function admitDormantSpinTicket(owner: PrismaClient, args: {
  userId: string; roundId: string; holdId: string; selections: unknown;
}) {
  identifier(args.roundId, 'Round ID');
  if (!/^[A-Za-z0-9_-]{1,121}$/.test(args.holdId)) throw ApiError.badRequest('Invalid hold ID');
  const bets = parseSpin90Bets(args.selections);
  const canonical = JSON.stringify(bets);
  const { model, ticket } = quoteSpin90Ticket(bets);
  if (ticket.stake > 480n) throw ApiError.badRequest('Spin ticket exceeds limit');
  const financialTicket = { roundId: args.roundId, bets: canonical,
    payouts: ticket.payouts.map((amount) => Number(amount)) };
  const reservationId = `ticket:${args.holdId}`;

  return owner.$transaction(async (tx) => {
    // Replay must work after pause/cutoff without re-checking mutable gates.
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'house-ticket:' + args.holdId},0))) AS lock_wait`;
    const prior = await tx.scheduledStakeHold.findUnique({ where: { id: args.holdId } });
    if (prior) {
      const held = await reserveScheduledStakeCoins(tx, args.userId, {
        holdId: args.holdId, amount: Number(ticket.stake), policy: { id: prior.policyId, version: prior.policyVersion },
        gameKey: 'spin_win', rulesId: SPIN90_RULES_ID, financialTicket,
      });
      const reserve = await tx.houseRoundReservation.findUnique({ where: { roundId: reservationId } });
      if (!reserve || reserve.stakeTotal !== ticket.stake || reserve.payoutVector === null ||
        JSON.stringify(reserve.payoutVector) !== JSON.stringify(financialTicket.payouts)) {
        throw ApiError.conflict('Financial ticket reserve proof mismatch');
      }
      return { ticketId: args.holdId, roundId: args.roundId, coinsBalance: held.coinsBalance,
        lossReserve: reserve.reservedLoss, isReplay: true };
    }
    await requirePlatformGate(tx, 'HOUSE_TICKET_ADMISSION');
    await lockUserForPlay(tx, args.userId);
    const jurisdiction = requirePlayableJurisdiction(await resolveJurisdictionForPlay(tx, args.userId));
    const game = await lockGameForPlay(tx, 'spin_win');
    if (!game || game.catalogStatus !== 'AVAILABLE' || !game.isActive || !game.currentRulesVersion) {
      throw ApiError.forbidden('Spin Win wagering is unavailable');
    }
    const rules = await tx.gameRules.findUnique({
      where: { gameId_version: { gameId: game.id, version: game.currentRulesVersion } },
    });
    if ((rules?.rules as Record<string, unknown> | null)?.rulesId !== SPIN90_RULES_ID) {
      throw ApiError.forbidden('No active Spin Win 90% rules');
    }
    const [account] = await tx.$queryRaw<Array<{ funded_amount: bigint; reserved_amount: bigint }>>`
      SELECT funded_amount,reserved_amount FROM public.house_capital_accounts WHERE currency='COINS' FOR UPDATE`;
    if (!account) throw ApiError.conflict('Operator capital is unavailable');
    const [round] = await tx.$queryRaw<Array<{
      id: string; game_key: string; rules_id: string; mode: string; state: string;
      opens_ms: bigint; closes_ms: bigint; enabled: boolean;
    }>>`
      SELECT g.id,g.game_key,g.rules_id,g.mode,g.state,g.opens_ms,g.closes_ms,s.enabled
      FROM public.scheduled_game_rounds g JOIN public.scheduled_game_streams s ON s.id=g.stream_id
      WHERE g.id=${args.roundId} FOR UPDATE OF g FOR SHARE OF s`;
    const [clock] = await tx.$queryRaw<Array<{ now_ms: bigint }>>`
      SELECT floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now_ms`;
    if (!round || !round.enabled || round.mode !== 'FINANCIAL' || round.state !== 'OPEN' ||
        round.game_key !== 'spin_win' || round.rules_id !== SPIN90_RULES_ID ||
        clock.now_ms < round.opens_ms || clock.now_ms >= round.closes_ms) {
      throw ApiError.conflict('Round is not accepting wagers');
    }
    const existing = await tx.$queryRaw<Array<{
      user_id: string; amount: number; snapshot: { financialTicket?: typeof financialTicket };
    }>>`
      SELECT h.user_id,h.amount,o.snapshot FROM public.scheduled_stake_holds h
      JOIN public.economic_operations o ON o.id=h.hold_operation_id
      WHERE o.snapshot->'financialTicket'->>'roundId'=${args.roundId} FOR SHARE OF h,o`;
    let book = emptyHouseBook(model);
    let userStake = 0n;
    for (const row of existing) {
      const saved = row.snapshot.financialTicket;
      if (!saved || saved.roundId !== args.roundId) throw ApiError.conflict('Round ticket proof mismatch');
      const repriced = quoteSpin90Ticket(JSON.parse(saved.bets)).ticket;
      if (repriced.stake !== BigInt(row.amount) ||
          JSON.stringify(repriced.payouts.map(Number)) !== JSON.stringify(saved.payouts)) {
        throw ApiError.conflict('Round ticket quote mismatch');
      }
      book = { model, stake: total([book.stake, repriced.stake], 'Round stake'),
        payouts: book.payouts.map((value, i) => total([value, repriced.payouts[i]], 'Round payout')) };
      if (row.user_id === args.userId) userStake = total([userStake, repriced.stake], 'User stake');
    }
    quoteHouseAdmission(book, ticket, {
      backedCapital: account.funded_amount, otherRoundLossReserves: account.reserved_amount,
      maxRoundLoss: 20_000n, maxRoundPayout: 20_000n,
      maxTicketStake: 480n, maxUserRoundStake: 480n,
    }, userStake);
    const held = await reserveScheduledStakeCoins(tx, args.userId, {
      holdId: args.holdId, amount: Number(ticket.stake),
      policy: { id: jurisdiction.policy.id, version: jurisdiction.policy.version },
      gameKey: 'spin_win', rulesId: SPIN90_RULES_ID, financialTicket,
    });
    const [reserved] = await tx.$queryRaw<Array<{ loss: bigint }>>`
      SELECT public.house_reserve_round_loss(${reservationId},${ticket.stake},
        ${JSON.stringify(financialTicket.payouts)}::jsonb,${1}::integer) AS loss`;
    await tx.$executeRawUnsafe('SET CONSTRAINTS house_capital_account_proof, house_reservation_proof, house_financial_hold_proof, house_financial_reserve_proof IMMEDIATE');
    return { ticketId: args.holdId, roundId: args.roundId, coinsBalance: held.coinsBalance,
      lossReserve: reserved.loss, isReplay: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 20_000, maxWait: 5_000 });
}
