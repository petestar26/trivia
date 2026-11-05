import type { SpinBet } from './spin-win.js';

export const SCHEDULED_SPIN_MAX_TICKETS = 10;

/** Practice selections have no wallet, prize claim or redeemable balance. */
export interface ScheduledPracticeTicket {
  bets: SpinBet[];
  acceptedAt: string;
  stake: number;
  payout: number | null;
}
export interface ScheduledPracticeSlottedTicket extends ScheduledPracticeTicket {
  slot: number;
}
export interface ScheduledPracticeRound {
  id: string;
  sequence: string;
  opensAt: number;
  closesAt: number;
  revealEndsAt: number;
  endsAt: number;
  state: 'OPEN' | 'DRAWN';
  outcome: number | null;
  ticket: ScheduledPracticeTicket | null;
  /** Absent on older servers, which support only the legacy Bet 1. */
  tickets?: ScheduledPracticeSlottedTicket[];
}
export interface ScheduledPracticeSnapshot {
  streamId: string;
  enabled: boolean;
  mode: 'PRACTICE';
  coinsAccepted: false;
  serverTime: number;
  nextOpensAt: number | null;
  rounds: ScheduledPracticeRound[];
  maxTickets?: number;
}
