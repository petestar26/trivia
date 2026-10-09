import {
  VF_LIMITS,
  VF_RULES_ID,
  fixtureOffer,
  parseTicketInput,
  priceTicket,
  TicketRuleError,
  type FixtureParams,
  type LineInput,
  type PricedLine,
} from '@socialplay/shared';

/** One selection the member tapped. `quotedCents` is the price they were shown. */
export interface Pick {
  fixtureId: string;
  selection: string;
  quotedCents: number;
  offerDigest: string;
}
export interface MultipleDraft {
  id: number;
  /** Pick keys. One per fixture, 2–5 of them. */
  picks: string[];
  stake: number | null;
}
export interface SlipState {
  matchweekId: string | null;
  picks: Pick[];
  singles: Record<string, number | null>;
  multiples: MultipleDraft[];
  nextId: number;
}

export const pickKey = (p: Pick | { fixtureId: string; selection: string }) =>
  `${p.fixtureId}#${p.selection}`;
export const emptySlip = (matchweekId: string | null = null): SlipState => ({
  matchweekId,
  picks: [],
  singles: {},
  multiples: [],
  nextId: 1,
});

export const DEFAULT_STAKE = 10;
export const MAX_PICKS = VF_LIMITS.maxTicketLegs;

export type SlipAction =
  | { type: 'reset'; matchweekId: string | null }
  | { type: 'toggle'; pick: Pick }
  | { type: 'remove'; key: string }
  | { type: 'single'; key: string; stake: number | null }
  | { type: 'addMultiple'; keys: string[] }
  | { type: 'multipleStake'; id: number; stake: number | null }
  | { type: 'multipleToggle'; id: number; key: string }
  | { type: 'removeMultiple'; id: number }
  | {
      type: 'acceptPrices';
      quote: (
        fixtureId: string,
        selection: string
      ) => { oddsCents: number | null; digest: string } | null;
    }
  | { type: 'clear' };

function without(state: SlipState, key: string): SlipState {
  const singles = { ...state.singles };
  delete singles[key];
  return {
    ...state,
    picks: state.picks.filter((p) => pickKey(p) !== key),
    singles,
    // A multiple that falls below two selections is dissolved rather than kept invalid.
    multiples: state.multiples
      .map((m) => ({ ...m, picks: m.picks.filter((k) => k !== key) }))
      .filter((m) => m.picks.length >= VF_LIMITS.minLegsPerMultiple),
  };
}

export function slipReducer(state: SlipState, action: SlipAction): SlipState {
  switch (action.type) {
    case 'reset':
      return emptySlip(action.matchweekId);
    case 'clear':
      return emptySlip(state.matchweekId);
    case 'toggle': {
      const key = pickKey(action.pick);
      if (state.picks.some((p) => pickKey(p) === key)) return without(state, key);
      if (state.picks.length >= MAX_PICKS) return state;
      return {
        ...state,
        picks: [...state.picks, action.pick],
        singles: { ...state.singles, [key]: DEFAULT_STAKE },
      };
    }
    case 'remove':
      return without(state, action.key);
    case 'single':
      return state.picks.some((p) => pickKey(p) === action.key)
        ? { ...state, singles: { ...state.singles, [action.key]: action.stake } }
        : state;
    case 'addMultiple': {
      const picks = state.picks.filter((p) => action.keys.includes(pickKey(p)));
      const fixtures = new Set(picks.map((p) => p.fixtureId));
      if (
        picks.length !== action.keys.length ||
        fixtures.size !== picks.length ||
        picks.length < VF_LIMITS.minLegsPerMultiple ||
        picks.length > VF_LIMITS.maxLegsPerMultiple
      )
        return state;
      const id = state.nextId;
      return {
        ...state,
        nextId: id + 1,
        multiples: [...state.multiples, { id, picks: picks.map(pickKey), stake: DEFAULT_STAKE }],
      };
    }
    case 'multipleStake':
      return {
        ...state,
        multiples: state.multiples.map((m) =>
          m.id === action.id ? { ...m, stake: action.stake } : m
        ),
      };
    case 'multipleToggle': {
      const target = state.multiples.find((m) => m.id === action.id);
      const pick = state.picks.find((p) => pickKey(p) === action.key);
      if (!target || !pick) return state;
      const has = target.picks.includes(action.key);
      let next: string[];
      if (has) next = target.picks.filter((k) => k !== action.key);
      else {
        const clash = state.picks.some(
          (p) => target.picks.includes(pickKey(p)) && p.fixtureId === pick.fixtureId
        );
        if (clash || target.picks.length >= VF_LIMITS.maxLegsPerMultiple) return state;
        next = [...target.picks, action.key];
      }
      return {
        ...state,
        multiples:
          next.length >= VF_LIMITS.minLegsPerMultiple
            ? state.multiples.map((m) => (m.id === action.id ? { ...m, picks: next } : m))
            : state.multiples.filter((m) => m.id !== action.id),
      };
    }
    case 'removeMultiple':
      return { ...state, multiples: state.multiples.filter((m) => m.id !== action.id) };
    case 'acceptPrices': {
      let next = state;
      for (const pick of state.picks) {
        const quote = action.quote(pick.fixtureId, pick.selection);
        if (!quote || quote.oddsCents === null) {
          next = without(next, pickKey(pick));
          continue;
        }
        const fresh = quote.oddsCents;
        next = {
          ...next,
          picks: next.picks.map((p) =>
            pickKey(p) === pickKey(pick)
              ? { ...p, quotedCents: fresh, offerDigest: quote.digest }
              : p
          ),
        };
      }
      return next;
    }
  }
}

/** Lines in the order they are shown and sent. Singles first, then multiples. */
export function buildLines(state: SlipState): LineInput[] {
  const lines: LineInput[] = [];
  for (const pick of state.picks) {
    const stake = state.singles[pickKey(pick)];
    if (stake && stake > 0)
      lines.push({
        kind: 'SINGLE',
        stake,
        legs: [
          { fixtureId: pick.fixtureId, selection: pick.selection, oddsCents: pick.quotedCents },
        ],
      });
  }
  for (const multiple of state.multiples) {
    if (!multiple.stake || multiple.stake <= 0) continue;
    const legs = multiple.picks
      .map((k) => state.picks.find((p) => pickKey(p) === k))
      .filter((p): p is Pick => !!p)
      .map((p) => ({ fixtureId: p.fixtureId, selection: p.selection, oddsCents: p.quotedCents }));
    lines.push({ kind: 'MULTIPLE', stake: multiple.stake, legs });
  }
  return lines;
}

export interface SlipLinePreview {
  line: LineInput;
  combinedOddsCents: number | null;
  maxReturn: number | null;
  error: string | null;
}
export interface SlipPreview {
  lines: SlipLinePreview[];
  totalStake: number;
  totalMaxReturn: number | null;
  /** First reason the whole ticket cannot be confirmed, or null. */
  error: string | null;
}

const PREVIEW_KEY = 'preview-key-not-sent-0000';

/**
 * Prices the slip with the exact shared rules the server uses. Line-level problems are
 * reported per line; ticket-level problems (limits across lines) in `error`.
 */
export function previewSlip(
  state: SlipState,
  paramsOf: (fixtureId: string) => FixtureParams | null
): SlipPreview {
  const lines = buildLines(state);
  const totalStake = lines.reduce((n, l) => n + l.stake, 0);
  const previews: SlipLinePreview[] = lines.map((line) => {
    try {
      const priced = priceTicket(
        parseTicketInput({
          idempotencyKey: PREVIEW_KEY,
          matchweekId: state.matchweekId,
          rulesId: VF_RULES_ID,
          lines: [line],
        }),
        paramsOf
      );
      const only: PricedLine = priced.lines[0];
      return {
        line,
        combinedOddsCents: only.combinedOddsCents,
        maxReturn: only.maxReturn,
        error: null,
      };
    } catch (e) {
      return {
        line,
        combinedOddsCents: null,
        maxReturn: null,
        error: e instanceof TicketRuleError ? e.message : 'Line is not valid',
      };
    }
  });
  let error: string | null = null;
  if (!lines.length) error = 'Add a stake to at least one selection.';
  else {
    const bad = previews.find((p) => p.error);
    if (bad) error = bad.error;
    else {
      try {
        const priced = priceTicket(
          parseTicketInput({
            idempotencyKey: PREVIEW_KEY,
            matchweekId: state.matchweekId,
            rulesId: VF_RULES_ID,
            lines,
          }),
          paramsOf
        );
        return { lines: previews, totalStake, totalMaxReturn: priced.totalMaxReturn, error: null };
      } catch (e) {
        error = e instanceof TicketRuleError ? e.message : 'Ticket is not valid';
      }
    }
  }
  const sum = previews.every((p) => p.maxReturn !== null)
    ? previews.reduce((n, p) => n + (p.maxReturn ?? 0), 0)
    : null;
  return { lines: previews, totalStake, totalMaxReturn: sum, error };
}

/** Picks whose shown price no longer matches the current official offer. */
export function stalePicks(
  state: SlipState,
  current: (
    fixtureId: string,
    selection: string
  ) => { oddsCents: number | null; digest: string } | null
): Pick[] {
  return state.picks.filter((p) => {
    const quote = current(p.fixtureId, p.selection);
    return !quote || quote.oddsCents !== p.quotedCents || quote.digest !== p.offerDigest;
  });
}

export function quoteFor(params: FixtureParams, selection: string) {
  const offer = fixtureOffer(params);
  const price = offer.byId.get(selection);
  return price ? { oddsCents: price.oddsCents, digest: offer.digest } : null;
}

/** The official offer for a selection in a fixture as the server created it. */
export function currentQuote(
  fixture: { params: FixtureParams; offerDigest: string },
  selection: string
) {
  const quote = quoteFor(fixture.params, selection);
  return quote ? { oddsCents: quote.oddsCents, digest: fixture.offerDigest } : null;
}
