import { describe, expect, it } from 'vitest';
import { deriveCompetitionPhase, normalizeCompetitionPhase } from './competition-lifecycle';

const STARTS_AT = '2030-01-01T00:00:00.000Z';
const ENDS_AT = '2030-01-01T01:00:00.000Z';

describe('competition lifecycle normalization', () => {
  it('matches the inclusive server timestamp semantics', () => {
    const competition = { status: 'SCHEDULED' as const, startsAt: STARTS_AT, endsAt: ENDS_AT };

    expect(deriveCompetitionPhase(competition, Date.parse(STARTS_AT) - 1)).toBe('UPCOMING');
    expect(deriveCompetitionPhase(competition, Date.parse(STARTS_AT))).toBe('OPEN');
    expect(deriveCompetitionPhase(competition, Date.parse(ENDS_AT))).toBe('OPEN');
    expect(deriveCompetitionPhase(competition, Date.parse(ENDS_AT) + 1)).toBe('ENDED');
  });

  it('keeps a supplied server phase authoritative', () => {
    const competition = {
      status: 'COMPLETED' as const,
      phase: 'OPEN' as const,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
    };

    const normalized = normalizeCompetitionPhase(competition, Date.parse(ENDS_AT) + 1);

    expect(normalized).toBe(competition);
    expect(normalized.phase).toBe('OPEN');
  });

  it('lets terminal persisted statuses override timestamps when phase is absent', () => {
    expect(normalizeCompetitionPhase({
      status: 'COMPLETED' as const,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
    }, Date.parse(STARTS_AT) - 1).phase).toBe('COMPLETED');

    expect(normalizeCompetitionPhase({
      status: 'CANCELLED' as const,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
    }, Date.parse(ENDS_AT) + 1).phase).toBe('CANCELLED');
  });
});
