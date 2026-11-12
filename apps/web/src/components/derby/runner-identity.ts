import { DERBY_HORSES } from '@socialplay/shared';

/** Presentation only: how each numbered runner looks. Never derived from odds, form or results. */
export type CoatSpec = {
  /** Body coat colour. */
  base: string;
  /** Lower legs ("points"); bays and browns carry black points. */
  points: string;
  mane: string;
  /** Hoof horn for unmarked legs; white socks get pale horn. */
  hoof: string;
  /** White sock height per leg in model units: front-left, front-right, hind-left, hind-right. */
  socks: readonly [number, number, number, number];
  /** 0 none, 1 star, 2 blaze, 3 stripe and snip. */
  face: 0 | 1 | 2 | 3;
  /** Dapple strength for greys. */
  dapple: number;
};
export type SilkPattern =
  | 'hoops'
  | 'sash'
  | 'crossbelts'
  | 'quartered'
  | 'chevrons'
  | 'braces'
  | 'halved'
  | 'stripes'
  | 'plain';
export type SilkSpec = {
  body: string;
  accent: string;
  pattern: SilkPattern;
  /** Sleeves: body colour, accent colour or accent hoops. */
  sleeves: 'body' | 'accent' | 'hoops';
  cap: string;
  capAccent: string;
  capPattern: 'plain' | 'quartered' | 'hooped' | 'peak';
};
export type RunnerLook = {
  number: number;
  /** The interface colour of this runner: saddle cloth, number badges and progress rows. */
  cloth: string;
  /** Legible ink for numbers on the cloth colour. */
  ink: string;
  coat: CoatSpec;
  silks: SilkSpec;
};

const COATS: readonly CoatSpec[] = [
  // 1 Royal Ember: bright chestnut, blaze, two hind socks.
  {
    base: '#8a4520',
    points: '#6d3417',
    mane: '#6a3216',
    hoof: '#3a322c',
    socks: [0, 0, 0.32, 0.26],
    face: 2,
    dapple: 0,
  },
  // 2 Midnight Blue: dark bay/brown, black points, small star.
  {
    base: '#3b2216',
    points: '#120e0c',
    mane: '#0f0c0b',
    hoof: '#2b2724',
    socks: [0, 0, 0, 0],
    face: 1,
    dapple: 0,
  },
  // 3 Silver Comet: dappled grey with grey points.
  {
    base: '#a8a59f',
    points: '#57534f',
    mane: '#d6d3cc',
    hoof: '#3d3935',
    socks: [0, 0, 0, 0],
    face: 0,
    dapple: 1,
  },
  // 4 Onyx Storm: black, near-black points, one hind sock.
  {
    base: '#1c1817',
    points: '#100e0d',
    mane: '#0c0a0a',
    hoof: '#2a2624',
    socks: [0, 0, 0.22, 0],
    face: 3,
    dapple: 0,
  },
  // 5 Golden Hour: light chestnut with flaxen mane.
  {
    base: '#a5612c',
    points: '#8a4d22',
    mane: '#d9b47a',
    hoof: '#4a3f34',
    socks: [0.2, 0, 0, 0.3],
    face: 2,
    dapple: 0,
  },
  // 6 Emerald Run: classic bay with black points.
  {
    base: '#6e391b',
    points: '#16110f',
    mane: '#120e0c',
    hoof: '#2e2925',
    socks: [0, 0, 0, 0],
    face: 1,
    dapple: 0,
  },
  // 7 Desert Rose: liver chestnut, stripe and four low socks.
  {
    base: '#4f2717',
    points: '#3f1f12',
    mane: '#3a1c10',
    hoof: '#3a322c',
    socks: [0.16, 0.16, 0.2, 0.2],
    face: 3,
    dapple: 0,
  },
  // 8 Violet Crown: light iron grey.
  {
    base: '#7d7a76',
    points: '#3a3836',
    mane: '#5b5854',
    hoof: '#33302d',
    socks: [0, 0, 0, 0],
    face: 1,
    dapple: 0.6,
  },
];

// Body colour follows each runner's interface colour, so the jockey matches the
// numbered badge and progress row. Distinct patterns and caps keep runners
// separable for colour-blind viewers and in small phone views.
const SILKS: readonly Omit<SilkSpec, 'body'>[] = [
  { accent: '#ffffff', pattern: 'hoops', sleeves: 'body', cap: '#ffffff', capAccent: '#e95c59', capPattern: 'plain' },
  { accent: '#f6c55e', pattern: 'sash', sleeves: 'accent', cap: '#f6c55e', capAccent: '#4d8dff', capPattern: 'plain' },
  { accent: '#1d2b4f', pattern: 'crossbelts', sleeves: 'hoops', cap: '#1d2b4f', capAccent: '#e8edf2', capPattern: 'quartered' },
  { accent: '#17151c', pattern: 'quartered', sleeves: 'body', cap: '#17151c', capAccent: '#8c85a7', capPattern: 'hooped' },
  { accent: '#1b1b1b', pattern: 'chevrons', sleeves: 'accent', cap: '#f6c55e', capAccent: '#1b1b1b', capPattern: 'peak' },
  { accent: '#ffffff', pattern: 'braces', sleeves: 'hoops', cap: '#ffffff', capAccent: '#4dd5a1', capPattern: 'quartered' },
  { accent: '#ffffff', pattern: 'halved', sleeves: 'accent', cap: '#ec8dc2', capAccent: '#ffffff', capPattern: 'hooped' },
  { accent: '#ffffff', pattern: 'stripes', sleeves: 'body', cap: '#af8aff', capAccent: '#ffffff', capPattern: 'plain' },
];

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string) {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}
export function contrastRatio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Dark or light number ink, whichever contrasts more with the cloth. */
export function inkFor(cloth: string) {
  return contrastRatio(cloth, '#101418') >= contrastRatio(cloth, '#fffaf0') ? '#101418' : '#fffaf0';
}

export function runnerLook(index: number): RunnerLook {
  const i = ((index % 8) + 8) % 8;
  const cloth = DERBY_HORSES[i].color;
  return {
    number: i + 1,
    cloth,
    ink: inkFor(cloth),
    coat: COATS[i],
    silks: { body: cloth, ...SILKS[i] },
  };
}
