/** The upstream catalogue often labels every game from a studio as Slots.
 * Keep the provider's specific genres and repair clear title/metadata matches.
 * A live table belongs to both Live and Table; a fishing-themed slot does not
 * become a fishing game just because its title mentions fish.
 */
const aliases: Record<string, string> = {
  slots: 'slots',
  slot: 'slots',
  'video slots': 'slots',
  live: 'live',
  'live casino': 'live',
  'live dealer': 'live',
  table: 'table',
  'table games': 'table',
  blackjack: 'table',
  roulette: 'table',
  baccarat: 'table',
  poker: 'table',
  'video poker': 'table',
  craps: 'table',
  'sic bo': 'table',
  crash: 'crash',
  'crash games': 'crash',
  instant: 'instant',
  'instant win': 'instant',
  arcade: 'instant',
  keno: 'keno',
  bingo: 'bingo',
  fishing: 'fishing',
  'fishing games': 'fishing',
  virtual: 'virtual',
  'virtual sports': 'virtual',
  sportsbook: 'sportsbook',
  'sports book': 'sportsbook',
  other: 'other',
};
const normalize = (value: unknown) =>
  typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
    : '';
const genre = (value: unknown) => {
  const key = normalize(value);
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined;
};

export function classifyProviderGame(row: { name: string; game_type?: unknown; type?: unknown }) {
  const reported = genre(row.game_type);
  const rawType = genre(row.type);
  // Sportsbooks must never enter the virtual casino, even under a bad label.
  if (reported === 'sportsbook' || rawType === 'sportsbook')
    return { category: 'sportsbook', categories: ['sportsbook'] };
  const base = reported && reported !== 'other' ? reported : (rawType ?? 'other');
  const title = normalize(row.name);
  const specific = /\bkeno\b/.test(title)
    ? 'keno'
    : /\bbingo\b/.test(title)
      ? 'bingo'
      : /\b(black\s?jack|roulette|baccarat|poker|craps|sic\s?bo)\b/.test(title)
        ? 'table'
        : /\bcrash\b/.test(title) || /^(jetx3?|spaceman|aviatrix)$/.test(title)
          ? 'crash'
          : rawType && !['slots', 'other'].includes(rawType)
            ? rawType
            : undefined;
  // Preserve known genre classifications. Only replace broad/incorrect labels.
  const category = specific && ['slots', 'instant', 'other'].includes(base) ? specific : base;
  return { category, categories: [...new Set([category, ...(specific ? [specific] : [])])] };
}
