/**
 * Competition lifecycle — server-derived time phase, independent of the
 * persisted CompetitionStatus column.
 *
 * The persisted status is only ever written to COMPLETED/CANCELLED by terminal
 * mutations (finalize/cancel). The SCHEDULED→ACTIVE transition is not driven
 * by any production path, so the timestamp window is the authority for whether
 * a competition is currently joinable/playable:
 *
 *   UPCOMING   non-terminal and now <  startsAt
 *   OPEN       non-terminal and startsAt <= now <= endsAt
 *   ENDED      non-terminal and now >  endsAt
 *   COMPLETED  persisted status COMPLETED (terminal override)
 *   CANCELLED  persisted status CANCELLED (terminal override)
 *
 * Terminal statuses override timestamps so finalized/cancelled competitions are
 * never re-opened by the clock.
 */

export type CompetitionLifecyclePhase =
  | 'UPCOMING'
  | 'OPEN'
  | 'ENDED'
  | 'COMPLETED'
  | 'CANCELLED';

type PersistedCompetitionStatus = 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

/**
 * Pure timestamp/status to phase derivation. The exact start and end
 * boundaries are included in OPEN (matches the backend join/play window, which
 * rejects only when now < startsAt or now > endsAt).
 */
export function competitionLifecyclePhase(
  status: PersistedCompetitionStatus,
  startsAt: Date | string,
  endsAt: Date | string,
  now: Date = new Date(),
): CompetitionLifecyclePhase {
  if (status === 'COMPLETED' || status === 'CANCELLED') return status;

  const current = now.getTime();
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();

  if (current < start) return 'UPCOMING';
  if (current <= end) return 'OPEN';
  return 'ENDED';
}

export interface CompetitionLifecycleInfo {
  phase: CompetitionLifecyclePhase;
  /** True when a maxParticipants cap exists and the cap is already reached. */
  isFull: boolean;
}

/**
 * Derived read-side info attached to competition list/detail payloads. Pure
 * derivation — never a source of truth for mutations (the backend remains
 * authoritative for every join/play/finalize).
 */
export function competitionLifecycleInfo(
  competition: {
    status: PersistedCompetitionStatus;
    startsAt: Date | string;
    endsAt: Date | string;
    maxParticipants: number | null;
    participantCount: number;
  },
  now: Date = new Date(),
): CompetitionLifecycleInfo {
  const phase = competitionLifecyclePhase(
    competition.status,
    competition.startsAt,
    competition.endsAt,
    now,
  );
  const isFull =
    competition.maxParticipants !== null && competition.participantCount >= competition.maxParticipants;
  return { phase, isFull };
}