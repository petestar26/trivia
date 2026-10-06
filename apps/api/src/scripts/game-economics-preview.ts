import { quotePvpEntry } from '@socialplay/shared';
import { GAME_ECONOMICS, ECONOMICS_POLICY, PVP_POLICY } from '../games/economics/policy.js';
import { planContestSettlement } from '../games/economics/contest-pool.js';
import { quoteSpin90Ticket } from '../games/economics/models.js';
import { emptyHouseBook, quoteHouseAdmission } from '../games/economics/house-risk.js';

// Offline preview only. No database URL, credentials, RNG or wallet writes.
const { model, ticket } = quoteSpin90Ticket([{ marketId: 'number:7', amount: 40 }]);
const risk = quoteHouseAdmission(emptyHouseBook(model), ticket, {
  backedCapital: 10_000n, otherRoundLossReserves: 0n,
  maxRoundLoss: 2_000n, maxRoundPayout: 3_000n,
  maxTicketStake: 480n, maxUserRoundStake: 480n,
}, 0n);
const entryQuote = quotePvpEntry(PVP_POLICY, '100');
const pool = planContestSettlement({ policy: PVP_POLICY, currency: 'COINS', contributions: [
  { id: 'receipt-1', userId: 'player-a', kind: 'ENTRY', amount: 100n },
  { id: 'receipt-2', userId: 'player-b', kind: 'ENTRY', amount: 100n },
] }, { status: 'COMPLETED', winnerIds: ['player-a'] });

console.log(JSON.stringify({
  status: 'OFFLINE_PREVIEW_NOT_LIVE',
  policy: ECONOMICS_POLICY,
  games: GAME_ECONOMICS,
  exampleOnlyNotProductionLimits: true,
  house: { stake: ticket.stake, maxGrossPayout: risk.maxGrossPayout, requiredLossReserve: risk.requiredLossReserve },
  contest: pool,
  entryQuote,
  missingLiveAdapters: ['provenance escrow', 'atomic treasury reservation', 'durable scheduler', 'fee journal', 'player disclosure'],
}, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
