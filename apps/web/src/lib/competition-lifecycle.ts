import type { Competition, CompetitionPhase } from './api';

type CompetitionLifecycleSource = Pick<Competition, 'status' | 'startsAt' | 'endsAt'> & {
  phase?: CompetitionPhase;
};

export function deriveCompetitionPhase(
  competition: Pick<CompetitionLifecycleSource, 'status' | 'startsAt' | 'endsAt'>,
  now: number = Date.now(),
): CompetitionPhase {
  if (competition.status === 'COMPLETED' || competition.status === 'CANCELLED') {
    return competition.status;
  }

  const start = new Date(competition.startsAt).getTime();
  const end = new Date(competition.endsAt).getTime();
  if (now < start) return 'UPCOMING';
  if (now <= end) return 'OPEN';
  return 'ENDED';
}

/**
 * Ensures React Query caches a lifecycle phase even when an older API omits it.
 * A supplied server phase is returned unchanged and remains authoritative.
 */
export function normalizeCompetitionPhase<T extends CompetitionLifecycleSource>(
  competition: T,
  now: number = Date.now(),
): T & { phase: CompetitionPhase } {
  if (competition.phase !== undefined) {
    return competition as T & { phase: CompetitionPhase };
  }

  return {
    ...competition,
    phase: deriveCompetitionPhase(competition, now),
  };
}
