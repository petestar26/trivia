import type { SpinBet } from './spin-win.js';

/** Practice selections have no wallet, prize claim or redeemable balance. */
export interface ScheduledPracticeTicket {
  bets: SpinBet[];
  acceptedAt: string;
  stake: number;
  payout: number | null;
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
}
export interface ScheduledPracticeSnapshot {
  streamId: string;
  enabled: boolean;
  mode: 'PRACTICE';
  coinsAccepted: false;
  serverTime: number;
  nextOpensAt: number | null;
  rounds: ScheduledPracticeRound[];
}
