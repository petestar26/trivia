import type { Cycle, CyclePhase } from './schedule.js';
import type { FixtureParams } from './model.js';
import type { LiveFixture } from './outcome.js';
import type { StandingRow } from './standings.js';
import type { LineKind } from './ticket.js';

/** Public view of one fixture. Only elapsed events are ever present before full time. */
export interface VfFixtureView {
  id: string;
  slot: number;
  homeClub: number;
  awayClub: number;
  /** Public immutable team-strength parameters recorded when the fixture was created. */
  params: FixtureParams;
  offerDigest: string;
  commitment: string;
  live: LiveFixture;
}

export interface VfMatchweekView {
  id: string;
  seasonNo: number;
  weekNo: number;
  opensAt: number;
  kickoffAt: number;
  halftimeAt: number;
  secondHalfAt: number;
  fullTimeAt: number;
  endsAt: number;
  commitment: string;
  /** Revealed only once full time has passed. */
  seed: string | null;
  fixtures: VfFixtureView[];
}

export type VfLegResult = 'PENDING' | 'WON' | 'LOST';
export interface VfTicketLegView {
  fixtureId: string;
  selection: string;
  oddsCents: number;
  result: VfLegResult;
}
export interface VfTicketLineView {
  lineNo: number;
  kind: LineKind;
  stake: number;
  oddsProduct: string;
  combinedOddsCents: number;
  maxReturn: number;
  payout: number | null;
  legs: VfTicketLegView[];
}
export interface VfTicketView {
  id: string;
  matchweekId: string;
  rulesId: string;
  rulesDigest: string;
  requestHash: string;
  receiptHash: string;
  totalStake: number;
  totalReturn: number | null;
  createdAt: number;
  settledAt: number | null;
  lines: VfTicketLineView[];
}

export interface VfScheduledFixture {
  slot: number;
  homeClub: number;
  awayClub: number;
}
export interface VfViewedWeek {
  seasonNo: number;
  weekNo: number;
  /** FUTURE = not yet open; NOT_PLAYED = elapsed without being created (missed). */
  state: 'AVAILABLE' | 'FUTURE' | 'NOT_PLAYED';
  matchweek: VfMatchweekView | null;
  scheduled: VfScheduledFixture[];
  opensAt: number;
}

export interface VfSnapshot {
  rulesId: string;
  rulesDigest: string;
  serverTime: number;
  /** Practice credits. Never Coins. */
  balance: number;
  cycle: Cycle & { phase: CyclePhase };
  current: VfMatchweekView | null;
  latestCompleted: VfMatchweekView | null;
  viewed: VfViewedWeek | null;
  standings: { seasonNo: number; weeksCompleted: number; rows: StandingRow[] };
  seasons: Array<{ seasonNo: number; weeksCompleted: number }>;
  tickets: VfTicketView[];
}

export interface VfAdmission {
  accepted: true;
  isReplay: boolean;
  ticket: VfTicketView;
}
