import {
  VF_CLUBS as MODEL_CLUBS,
  colourDistance,
  kitSeparation,
  VF_MIN_KIT_DISTANCE,
  VF_MIN_PATTERN_DISTANCE,
  type Club,
  type ClubKit,
} from '@socialplay/shared';

/** Display aliases only. Immutable simulation IDs, model codes and strengths stay unchanged.
 * Club membership checked against the Premier League 2026/27 squad lists on 2026-10-10.
 * Original generic shields/kits; no official badges, sponsors or player likenesses.
 */
const identities: Array<[string, string, string, string, ClubKit['pattern']?]> = [
  ['Arsenal', 'ARS', '#d71920', '#ffffff'],
  ['Aston Villa', 'AVL', '#781e3c', '#95bfe5'],
  ['AFC Bournemouth', 'BOU', '#c8102e', '#17191d', 'stripes'],
  ['Brentford', 'BRE', '#d71920', '#ffffff', 'stripes'],
  ['Brighton & Hove Albion', 'BHA', '#1267b1', '#ffffff', 'stripes'],
  ['Chelsea', 'CHE', '#1745a5', '#ffffff'],
  ['Coventry City', 'COV', '#79bce5', '#ffffff'],
  ['Crystal Palace', 'CRY', '#2354a5', '#c51d32', 'stripes'],
  ['Everton', 'EVE', '#164da0', '#ffffff'],
  ['Fulham', 'FUL', '#f5f5ef', '#20232a'],
  ['Hull City', 'HUL', '#e9a52a', '#15191e', 'stripes'],
  ['Ipswich Town', 'IPS', '#2867b7', '#ffffff'],
  ['Leeds United', 'LEE', '#f4f4ef', '#203675'],
  ['Liverpool', 'LIV', '#c7192e', '#ffffff'],
  ['Manchester City', 'MCI', '#74b9df', '#ffffff'],
  ['Manchester United', 'MUN', '#da2430', '#ffffff'],
  ['Newcastle United', 'NEW', '#252930', '#ffffff', 'stripes'],
  ['Nottingham Forest', 'NFO', '#d52130', '#ffffff'],
  ['Sunderland', 'SUN', '#d52837', '#ffffff', 'stripes'],
  ['Tottenham Hotspur', 'TOT', '#f5f5ef', '#19243d'],
];
export const VF_CLUBS: readonly Club[] = Object.freeze(
  MODEL_CLUBS.map((model, i) => {
    const [name, code, primary, secondary, pattern = 'solid'] = identities[i];
    return Object.freeze({
      ...model,
      name,
      code,
      home: { primary, secondary, pattern },
      away: { primary: '#222b3c', secondary: '#e5cf93', pattern: 'solid' as const },
    });
  })
);
export function clubById(id: number): Club {
  const club = VF_CLUBS[id - 1];
  if (!club || club.id !== id) throw new RangeError('Unknown club');
  return club;
}
export function matchKits(homeId: number, awayId: number) {
  const home = clubById(homeId).home,
    away = clubById(awayId);
  const options: ClubKit[] = [
    away.home,
    away.away,
    { primary: '#fafaf7', secondary: '#111111', pattern: 'solid' },
    { primary: '#111111', secondary: '#fafaf7', pattern: 'solid' },
    { primary: '#f4b400', secondary: '#111111', pattern: 'solid' },
    { primary: '#0f8b8d', secondary: '#fafaf7', pattern: 'solid' },
  ];
  const mainOk = (kit: ClubKit) => colourDistance(kit.primary, home.primary) >= VF_MIN_KIT_DISTANCE;
  return {
    home,
    away:
      options.find((k) => mainOk(k) && kitSeparation(k, home) >= VF_MIN_PATTERN_DISTANCE) ??
      options.find(mainOk) ??
      options[options.length - 1],
  };
}
