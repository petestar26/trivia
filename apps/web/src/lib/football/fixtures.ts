import { scheduledWeek } from '@socialplay/shared';

/** Teams of a fixture, recomputed from the public schedule (no network, no trust in a label). */
export function fixtureTeams(fixtureId: string): { homeClub: number; awayClub: number } | null {
  const m = /^vf-s([1-9]\d{0,5})-w(\d{2})-f(\d{2})$/.exec(fixtureId);
  if (!m) return null;
  try {
    const slot = scheduledWeek(Number(m[1]), Number(m[2])).find((f) => f.slot === Number(m[3]));
    return slot ? { homeClub: slot.homeClub, awayClub: slot.awayClub } : null;
  } catch {
    return null;
  }
}

export const weekLabel = (seasonNo: number, weekNo: number) =>
  `Season ${seasonNo} · Matchweek ${weekNo}`;
export function matchweekLabel(id: string) {
  const m = /^vf-s(\d+)-w(\d+)$/.exec(id);
  return m ? weekLabel(Number(m[1]), Number(m[2])) : id;
}
