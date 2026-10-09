import { canonicalJson, sha256Hex } from './hash.js';

/**
 * PlayQube Virtual Football 3D: original practice game. Not MOHIO's engine, timing, odds
 * model or certification. Credits are non-purchasable, non-transferable and non-redeemable
 * and never touch Coins or the financial ledger.
 */
export const VF_GAME_KEY = 'virtual_football_3d';
export const VF_RULES_ID = 'virtual-football-3d-practice-v1';
export const VF_MODEL_ID = 'vf3d-score-model-v1';
export const VF_SCHEDULE_ID = 'vf3d-schedule-v1';
export const VF_DOMAIN = 'playqube.vf3d.v1';

export const VF_TIMING = Object.freeze({
  /** Cycle boundaries are multiples of cycleMs after anchorMs (2026-10-05T00:00:00Z). */
  anchorMs: 1_791_158_400_000,
  cycleMs: 300_000,
  selectionMs: 230_000,
  firstHalfMs: 28_000,
  halftimeMs: 4_000,
  secondHalfMs: 28_000,
  matchMs: 60_000,
  resultsMs: 10_000,
  weeksPerSeason: 38,
  fixturesPerWeek: 10,
  clubCount: 20,
});

export const VF_LIMITS = Object.freeze({
  initialBalance: 1000,
  minLineStake: 5,
  maxLineStake: 500,
  maxTicketStake: 1000,
  maxLines: 8,
  minLegsPerMultiple: 2,
  maxLegsPerMultiple: 5,
  maxTicketLegs: 20,
  maxTicketsPerMatchweek: 10,
  /** Selections priced outside this window are unavailable, never re-priced. */
  minOddsCents: 110,
  maxOddsCents: 100_000,
  maxCombinedOddsCents: 1_000_000,
  maxLineReturn: 50_000,
  maxTicketReturn: 100_000,
});

/** Gross fixed odds = floor(RETURN_PERCENT / probability), in hundredths. */
export const VF_RETURN_PERCENT = 90;
/** Tail smoothing: W = SMOOTHING * poissonWeight + sum(poissonWeights). See docs. */
export const VF_SMOOTHING = 1000n;
export const VF_MAX_GOALS = 6;
export const VF_GOAL_LINES = Object.freeze([5, 15, 25, 35, 45] as const);
export const VF_GOAL_LINES_OFFERED = Object.freeze([15, 25, 35] as const);
export const VF_HANDICAP_LINES = Object.freeze([-1, 1] as const);
export const VF_BASE_GOALS_MILLI = Object.freeze({ home: 1450, away: 1150 });

export type KitPattern = 'solid' | 'stripes' | 'hoops' | 'halves' | 'sash';
export interface ClubKit {
  primary: string;
  secondary: string;
  pattern: KitPattern;
}
export type BadgeGlyph =
  | 'star'
  | 'crown'
  | 'wave'
  | 'bolt'
  | 'leaf'
  | 'anchor'
  | 'peak'
  | 'sun'
  | 'flame'
  | 'key'
  | 'falcon'
  | 'stag'
  | 'thistle'
  | 'lion'
  | 'fox'
  | 'gem'
  | 'tower'
  | 'ring'
  | 'shell'
  | 'arrow';
export interface Club {
  id: number;
  code: string;
  name: string;
  /** Public immutable team-strength parameters (100 is league average). */
  attack: number;
  defence: number;
  home: ClubKit;
  away: ClubKit;
  glyph: BadgeGlyph;
}

const k = (primary: string, secondary: string, pattern: KitPattern = 'solid'): ClubKit => ({
  primary,
  secondary,
  pattern,
});

/** Twenty fictional clubs. Names, crests and kits are original to PlayQube. */
export const VF_CLUBS: readonly Club[] = Object.freeze([
  {
    id: 1,
    code: 'ASM',
    name: 'Ashford Meridian',
    attack: 118,
    defence: 112,
    home: k('#d9382c', '#ffffff', 'stripes'),
    away: k('#1b1f2b', '#f2b134'),
    glyph: 'sun',
  },
  {
    id: 2,
    code: 'BWF',
    name: 'Blackwater Falcons',
    attack: 108,
    defence: 104,
    home: k('#1c2430', '#e4572e', 'sash'),
    away: k('#f1ece0', '#1c2430'),
    glyph: 'falcon',
  },
  {
    id: 3,
    code: 'COH',
    name: 'Cobalt Harbour',
    attack: 101,
    defence: 99,
    home: k('#1d4fd8', '#f5f7ff', 'hoops'),
    away: k('#f7d046', '#1d4fd8'),
    glyph: 'anchor',
  },
  {
    id: 4,
    code: 'DUS',
    name: 'Dunmoor Stags',
    attack: 96,
    defence: 108,
    home: k('#7a2f1b', '#f0d9a8', 'halves'),
    away: k('#2c7a5b', '#f4f1e6'),
    glyph: 'stag',
  },
  {
    id: 5,
    code: 'EMV',
    name: 'Ember Vale',
    attack: 112,
    defence: 92,
    home: k('#f28c28', '#1c1c1c', 'solid'),
    away: k('#2a2d34', '#f28c28', 'stripes'),
    glyph: 'flame',
  },
  {
    id: 6,
    code: 'FRA',
    name: 'Frostholm Athletic',
    attack: 90,
    defence: 105,
    home: k('#cfe9f5', '#245a86', 'stripes'),
    away: k('#245a86', '#cfe9f5'),
    glyph: 'peak',
  },
  {
    id: 7,
    code: 'GLT',
    name: 'Glenmora Thistle',
    attack: 94,
    defence: 96,
    home: k('#6d2a8f', '#e9d85a', 'solid'),
    away: k('#e9d85a', '#6d2a8f'),
    glyph: 'thistle',
  },
  {
    id: 8,
    code: 'HCR',
    name: 'Highcrest Rovers',
    attack: 104,
    defence: 101,
    home: k('#0e8a6a', '#ffffff', 'halves'),
    away: k('#f4f4f0', '#0e8a6a'),
    glyph: 'crown',
  },
  {
    id: 9,
    code: 'IBU',
    name: 'Ironbridge Union',
    attack: 88,
    defence: 118,
    home: k('#4a5560', '#d94b4b', 'solid'),
    away: k('#d94b4b', '#2b3138'),
    glyph: 'tower',
  },
  {
    id: 10,
    code: 'JWL',
    name: 'Jadewater Lions',
    attack: 99,
    defence: 94,
    home: k('#12a38a', '#f6f1d4', 'sash'),
    away: k('#f6f1d4', '#12a38a'),
    glyph: 'lion',
  },
  {
    id: 11,
    code: 'KEP',
    name: 'Kestrel Park',
    attack: 92,
    defence: 90,
    home: k('#c61f5c', '#ffffff', 'hoops'),
    away: k('#222a38', '#c61f5c'),
    glyph: 'arrow',
  },
  {
    id: 12,
    code: 'LAT',
    name: 'Larkspur Town',
    attack: 85,
    defence: 92,
    home: k('#7f5ee0', '#f2f0ff', 'solid'),
    away: k('#f2f0ff', '#7f5ee0', 'hoops'),
    glyph: 'leaf',
  },
  {
    id: 13,
    code: 'MAH',
    name: 'Marrow Heath',
    attack: 106,
    defence: 97,
    home: k('#a62a2a', '#14213d', 'halves'),
    away: k('#e9e6df', '#a62a2a'),
    glyph: 'key',
  },
  {
    id: 14,
    code: 'NQM',
    name: 'Northquay Mariners',
    attack: 97,
    defence: 102,
    home: k('#0b3c5d', '#f3b61f', 'stripes'),
    away: k('#f3b61f', '#0b3c5d'),
    glyph: 'wave',
  },
  {
    id: 15,
    code: 'OHW',
    name: 'Oakhaven Wanderers',
    attack: 91,
    defence: 87,
    home: k('#2e6b34', '#f2d16b', 'solid'),
    away: k('#f2d16b', '#2e6b34', 'sash'),
    glyph: 'shell',
  },
  {
    id: 16,
    code: 'PCF',
    name: 'Pinecliff Foxes',
    attack: 102,
    defence: 108,
    home: k('#e8661b', '#f9f3e8', 'solid'),
    away: k('#26323f', '#e8661b', 'stripes'),
    glyph: 'fox',
  },
  {
    id: 17,
    code: 'QZB',
    name: 'Quartz Borough',
    attack: 83,
    defence: 84,
    home: k('#e6d9f5', '#5a3c8c', 'stripes'),
    away: k('#5a3c8c', '#e6d9f5'),
    glyph: 'gem',
  },
  {
    id: 18,
    code: 'RFS',
    name: 'Redfern Sporting',
    attack: 110,
    defence: 98,
    home: k('#b3122b', '#101010', 'hoops'),
    away: k('#f5f5f2', '#b3122b'),
    glyph: 'star',
  },
  {
    id: 19,
    code: 'SMS',
    name: 'Silvermere Swifts',
    attack: 95,
    defence: 89,
    home: k('#b9c4d0', '#26364a', 'sash'),
    away: k('#26364a', '#b9c4d0'),
    glyph: 'bolt',
  },
  {
    id: 20,
    code: 'TWH',
    name: 'Tidewell Harriers',
    attack: 87,
    defence: 95,
    home: k('#19a7ce', '#0a2342', 'halves'),
    away: k('#0a2342', '#19a7ce'),
    glyph: 'ring',
  },
]);

export function clubById(id: number): Club {
  const club = VF_CLUBS[id - 1];
  if (!club || club.id !== id) throw new RangeError('Unknown club');
  return club;
}

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
export function colourDistance(a: string, b: string) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  // Weighted RGB distance (redmean approximation). Integer in, integer out.
  const rm = (r1 + r2) >> 1;
  return Math.round(
    Math.sqrt(
      (((512 + rm) * (r1 - r2) ** 2) >> 8) +
        4 * (g1 - g2) ** 2 +
        (((767 - rm) * (b1 - b2) ** 2) >> 8)
    )
  );
}

const NEUTRAL_KITS: readonly ClubKit[] = [
  k('#fafaf7', '#111111'),
  k('#111111', '#fafaf7'),
  k('#f4b400', '#111111'),
  k('#0f8b8d', '#fafaf7'),
];
export const VF_MIN_KIT_DISTANCE = 110;
/** Patterned kits also keep their stripe/hoop colour this far from the opponent's colours. */
export const VF_MIN_PATTERN_DISTANCE = 90;

const palette = (kit: ClubKit) =>
  kit.pattern === 'solid' ? [kit.primary] : [kit.primary, kit.secondary];
/** Smallest colour distance between anything one kit shows and anything the other shows. */
export function kitSeparation(a: ClubKit, b: ClubKit) {
  return Math.min(...palette(a).flatMap((x) => palette(b).map((y) => colourDistance(x, y))));
}

/**
 * The home club always wears its home kit. The away club wears its home kit unless that
 * clashes, then its away kit, then the most distinct neutral kit. A kit clashes when its
 * main colour is too close to the opponent's, or (for stripes, hoops and the like) when any
 * colour it shows is too close to anything the opponent shows, so teams read apart on the pitch.
 */
export function matchKits(homeId: number, awayId: number): { home: ClubKit; away: ClubKit } {
  const home = clubById(homeId).home;
  const away = clubById(awayId);
  const options = [away.home, away.away, ...NEUTRAL_KITS];
  const mainOk = (kit: ClubKit) => colourDistance(kit.primary, home.primary) >= VF_MIN_KIT_DISTANCE;
  const usable =
    options.find((kit) => mainOk(kit) && kitSeparation(kit, home) >= VF_MIN_PATTERN_DISTANCE) ??
    options.find(mainOk);
  const best =
    usable ??
    options.reduce((a, b) =>
      colourDistance(a.primary, home.primary) >= colourDistance(b.primary, home.primary) ? a : b
    );
  return { home, away: best };
}

const KEEPER_COLOURS = ['#6ee05a', '#ff9d2e', '#ff4fa3', '#33d0ff', '#b6ff3d'];
/** Goalkeeper shirt colour most distinct from both outfield kits. */
export function keeperColour(...outfield: string[]) {
  let best = KEEPER_COLOURS[0];
  let bestScore = -1;
  for (const colour of KEEPER_COLOURS) {
    const score = Math.min(...outfield.map((o) => colourDistance(colour, o)));
    if (score > bestScore) {
      bestScore = score;
      best = colour;
    }
  }
  return best;
}

/** Digest of every parameter that defines pricing and admission. Receipts bind to it. */
export const VF_RULES_DIGEST = sha256Hex(
  canonicalJson({
    id: VF_RULES_ID,
    model: VF_MODEL_ID,
    schedule: VF_SCHEDULE_ID,
    timing: VF_TIMING,
    limits: VF_LIMITS,
    returnPercent: VF_RETURN_PERCENT,
    smoothing: VF_SMOOTHING.toString(),
    maxGoals: VF_MAX_GOALS,
    goalLinesOffered: [...VF_GOAL_LINES_OFFERED],
    handicapLines: [...VF_HANDICAP_LINES],
    baseGoalsMilli: VF_BASE_GOALS_MILLI,
    clubs: VF_CLUBS.map((c) => [c.id, c.code, c.attack, c.defence]),
  })
);
