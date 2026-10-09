import { VF_LIMITS, VF_RULES_DIGEST, VF_RULES_ID } from './constants.js';
import { canonicalJson, sha256Hex } from './hash.js';
import { fixtureOffer, parseSelection, type FixtureParams, type Outcome } from './model.js';
import { FIXTURE_ID, MATCHWEEK_ID } from './schedule.js';

export type LineKind = 'SINGLE' | 'MULTIPLE';
export interface LegInput {
  fixtureId: string;
  selection: string;
  /** The price the member saw. The server recomputes it and refuses a mismatch. */
  oddsCents: number;
}
export interface LineInput {
  kind: LineKind;
  stake: number;
  legs: LegInput[];
}
export interface TicketInput {
  idempotencyKey: string;
  matchweekId: string;
  rulesId: string;
  lines: LineInput[];
}

export type TicketErrorCode =
  | 'BAD_SHAPE'
  | 'RULES_MISMATCH'
  | 'DUPLICATE_LEG'
  | 'DUPLICATE_LINE'
  | 'MULTIPLE_SHAPE'
  | 'STAKE_LIMIT'
  | 'STALE_FIXTURE'
  | 'UNAVAILABLE_SELECTION'
  | 'PRICE_CHANGED'
  | 'ODDS_LIMIT'
  | 'RETURN_LIMIT';

export class TicketRuleError extends Error {
  constructor(
    readonly code: TicketErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TicketRuleError';
  }
}
const fail = (code: TicketErrorCode, message: string): never => {
  throw new TicketRuleError(code, message);
};

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Strict structural validation. Unknown properties anywhere are rejected. */
export function parseTicketInput(raw: unknown): TicketInput {
  const exact = (value: Record<string, unknown>, keys: string[], where: string) => {
    for (const key of Object.keys(value))
      if (!keys.includes(key)) fail('BAD_SHAPE', `Unexpected field "${key}" in ${where}`);
  };
  if (!isRecord(raw)) return fail('BAD_SHAPE', 'Ticket must be an object');
  exact(raw, ['idempotencyKey', 'matchweekId', 'rulesId', 'lines'], 'ticket');
  const { idempotencyKey, matchweekId, rulesId, lines } = raw;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey))
    fail('BAD_SHAPE', 'Receipt key is invalid');
  if (typeof matchweekId !== 'string' || !MATCHWEEK_ID.test(matchweekId))
    fail('BAD_SHAPE', 'Matchweek is invalid');
  if (rulesId !== VF_RULES_ID) fail('RULES_MISMATCH', 'These rules are out of date. Refresh the game.');
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > VF_LIMITS.maxLines)
    fail('BAD_SHAPE', `A ticket needs 1 to ${VF_LIMITS.maxLines} lines`);
  const parsed: LineInput[] = (lines as unknown[]).map((line) => {
    if (!isRecord(line)) return fail('BAD_SHAPE', 'Each line must be an object');
    exact(line, ['kind', 'stake', 'legs'], 'line');
    if (line.kind !== 'SINGLE' && line.kind !== 'MULTIPLE') fail('BAD_SHAPE', 'Line kind is invalid');
    if (!isInt(line.stake)) fail('BAD_SHAPE', 'Stake must be a whole number of credits');
    const stake = line.stake as number;
    if (stake < VF_LIMITS.minLineStake || stake > VF_LIMITS.maxLineStake)
      fail('STAKE_LIMIT', `Each line stake must be ${VF_LIMITS.minLineStake}–${VF_LIMITS.maxLineStake} credits`);
    if (!Array.isArray(line.legs)) return fail('BAD_SHAPE', 'Line legs must be a list');
    const legs = (line.legs as unknown[]).map((leg): LegInput => {
      if (!isRecord(leg)) return fail('BAD_SHAPE', 'Each leg must be an object');
      exact(leg, ['fixtureId', 'selection', 'oddsCents'], 'leg');
      if (typeof leg.fixtureId !== 'string' || !FIXTURE_ID.test(leg.fixtureId))
        fail('BAD_SHAPE', 'Fixture is invalid');
      if (!parseSelection(leg.selection)) fail('UNAVAILABLE_SELECTION', 'Selection is not recognised');
      if (!isInt(leg.oddsCents) || leg.oddsCents < VF_LIMITS.minOddsCents || leg.oddsCents > VF_LIMITS.maxOddsCents)
        fail('BAD_SHAPE', 'Odds are invalid');
      return { fixtureId: leg.fixtureId as string, selection: leg.selection as string, oddsCents: leg.oddsCents as number };
    });
    const kind = line.kind as LineKind;
    if (kind === 'SINGLE' && legs.length !== 1) fail('MULTIPLE_SHAPE', 'A single has exactly one selection');
    if (kind === 'MULTIPLE' && (legs.length < VF_LIMITS.minLegsPerMultiple || legs.length > VF_LIMITS.maxLegsPerMultiple))
      fail('MULTIPLE_SHAPE', `A multiple needs ${VF_LIMITS.minLegsPerMultiple}–${VF_LIMITS.maxLegsPerMultiple} selections`);
    if (new Set(legs.map((l) => l.fixtureId)).size !== legs.length)
      fail('DUPLICATE_LEG', 'A multiple takes one selection per match');
    for (const leg of legs)
      if (!leg.fixtureId.startsWith(`${matchweekId as string}-f`))
        fail('STALE_FIXTURE', 'Every selection must be in the same matchweek');
    return { kind, stake, legs };
  });
  const keys = parsed.map((l) => `${l.kind}|${l.legs.map((g) => `${g.fixtureId}#${g.selection}`).sort().join(',')}`);
  if (new Set(keys).size !== keys.length) fail('DUPLICATE_LINE', 'Duplicate lines are not allowed');
  const totalLegs = parsed.reduce((n, l) => n + l.legs.length, 0);
  if (totalLegs > VF_LIMITS.maxTicketLegs) fail('BAD_SHAPE', `A ticket holds at most ${VF_LIMITS.maxTicketLegs} selections`);
  const totalStake = parsed.reduce((n, l) => n + l.stake, 0);
  if (totalStake > VF_LIMITS.maxTicketStake) fail('STAKE_LIMIT', `A ticket stakes at most ${VF_LIMITS.maxTicketStake} credits`);
  return { idempotencyKey: idempotencyKey as string, matchweekId: matchweekId as string, rulesId: VF_RULES_ID, lines: parsed };
}

/* ------------------------------------------------------------------------------------- *
 * Odds and returns. Per-leg odds are in hundredths; the product is exact.
 * payout = floor(stake * prod(odds) / 100^n), one floor, no intermediate rounding.
 * ------------------------------------------------------------------------------------- */
export function oddsProduct(legOdds: number[]): bigint {
  return legOdds.reduce((p, o) => p * BigInt(o), 1n);
}
/** Displayed combined odds in hundredths, rounded down. Pure display; payout uses the product. */
export function combinedOddsCents(product: bigint, legs: number): bigint {
  return product / 100n ** BigInt(legs - 1);
}
export function linePayout(stake: number, product: bigint, legs: number): bigint {
  return (BigInt(stake) * product) / 100n ** BigInt(legs);
}

export interface PricedLine extends LineInput {
  oddsProduct: bigint;
  combinedOddsCents: number;
  /** Return if every selection wins (stake included). */
  maxReturn: number;
}
export interface PricedTicket extends TicketInput {
  lines: PricedLine[];
  totalStake: number;
  totalMaxReturn: number;
}

/**
 * Prices a structurally valid ticket against the matchweek's fixtures. Throws instead of
 * clamping when the price moved, a selection is unavailable, or a bound would be exceeded.
 */
export function priceTicket(
  input: TicketInput,
  fixtureParams: (fixtureId: string) => FixtureParams | null
): PricedTicket {
  let totalMaxReturn = 0;
  const lines = input.lines.map((line): PricedLine => {
    for (const leg of line.legs) {
      const params = fixtureParams(leg.fixtureId);
      if (!params) fail('STALE_FIXTURE', 'A selected match is not part of this matchweek');
      const price = fixtureOffer(params!).byId.get(leg.selection);
      if (!price || price.oddsCents === null)
        fail('UNAVAILABLE_SELECTION', 'A selection is not available for this match');
      if (price!.oddsCents !== leg.oddsCents)
        fail('PRICE_CHANGED', 'A displayed price no longer matches the official price. Refresh and review again.');
    }
    const product = oddsProduct(line.legs.map((l) => l.oddsCents));
    const combined = combinedOddsCents(product, line.legs.length);
    if (combined > BigInt(VF_LIMITS.maxCombinedOddsCents))
      fail('ODDS_LIMIT', `Combined odds cannot exceed ${(VF_LIMITS.maxCombinedOddsCents / 100).toFixed(2)}×`);
    const payout = linePayout(line.stake, product, line.legs.length);
    if (payout > BigInt(VF_LIMITS.maxLineReturn))
      fail('RETURN_LIMIT', `A line cannot return more than ${VF_LIMITS.maxLineReturn.toLocaleString('en-US')} credits`);
    totalMaxReturn += Number(payout);
    return { ...line, oddsProduct: product, combinedOddsCents: Number(combined), maxReturn: Number(payout) };
  });
  if (totalMaxReturn > VF_LIMITS.maxTicketReturn)
    fail('RETURN_LIMIT', `A ticket cannot return more than ${VF_LIMITS.maxTicketReturn.toLocaleString('en-US')} credits`);
  return { ...input, lines, totalStake: lines.reduce((n, l) => n + l.stake, 0), totalMaxReturn };
}

/** Identity of the request (not the key): line order, stakes, picks, rules and shown prices. */
export function ticketRequestHash(input: TicketInput) {
  return sha256Hex(
    canonicalJson({
      v: 1,
      matchweekId: input.matchweekId,
      rulesId: input.rulesId,
      lines: input.lines.map((l) => ({
        kind: l.kind,
        stake: l.stake,
        legs: l.legs.map((g) => ({ fixtureId: g.fixtureId, selection: g.selection, oddsCents: g.oddsCents })),
      })),
    })
  );
}

/** Immutable receipt binding: request, rules digest and each fixture's offered-price digest. */
export function receiptHash(input: {
  requestHash: string;
  matchweekId: string;
  totalStake: number;
  offerDigests: Record<string, string>;
}) {
  return sha256Hex(canonicalJson({ v: 1, rulesDigest: VF_RULES_DIGEST, ...input }));
}

/** A line wins only if every leg wins. Returns the integer payout, stake included. */
export function settleLine(
  line: Pick<PricedLine, 'stake' | 'oddsProduct'> & { legs: Array<{ fixtureId: string; selection: string }> },
  outcomeOf: (fixtureId: string) => Outcome
): number {
  const won = line.legs.every((leg) => parseSelection(leg.selection)!.test(outcomeOf(leg.fixtureId)));
  return won ? Number(linePayout(line.stake, line.oddsProduct, line.legs.length)) : 0;
}
