import { DERBY_RULES } from './thunder-derby.js';
/** Same published racing mathematics; independent race/commitment namespace. */
export const DOG_RACING_RULES = Object.freeze({ ...DERBY_RULES, id: 'dog-racing-uniform90-v1' });
// Presentation only. Each `ink` is the colour of the dog's number on `color` and
// must reach WCAG AA (4.5:1) on it; see dog-racing/racing-dogs-contrast.test.ts.
export const RACING_DOGS = [
  { name: 'Ruby Dash', color: '#d84448', ink: '#000000', coat: '#bc8f62' },
  { name: 'Blue Comet', color: '#377cce', ink: '#000000', coat: '#35312f' },
  { name: 'Pearl Runner', color: '#f1ede2', ink: '#181b20', coat: '#e4d8bf' },
  { name: 'Midnight', color: '#292e35', ink: '#ffffff', coat: '#777064' },
  { name: 'Golden Hour', color: '#e9c24f', ink: '#211c0e', coat: '#b67e49' },
  { name: 'Jade Spirit', color: '#378e70', ink: '#000000', coat: '#e0d9cd' },
  { name: 'Rose Arrow', color: '#d779a2', ink: '#24131b', coat: '#544943' },
  { name: 'Copper Wind', color: '#e88e49', ink: '#21170e', coat: '#a69583' },
] as const;
