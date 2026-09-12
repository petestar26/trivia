import { describe, it, expect } from 'vitest';
import {
  competitionLifecyclePhase,
  competitionLifecycleInfo,
} from './competition-lifecycle';

const STARTS_AT = new Date('2026-01-01T00:00:00.000Z');
const ENDS_AT = new Date('2026-01-02T00:00:00.000Z');

describe('competitionLifecyclePhase', () => {
  it('is UPCOMING before startsAt', () => {
    expect(
      competitionLifecyclePhase('SCHEDULED', STARTS_AT, ENDS_AT, new Date('2025-12-31T23:59:59.000Z'))
    ).toBe('UPCOMING');
  });

  it('is OPEN exactly at startsAt (exact start boundary)', () => {
    expect(competitionLifecyclePhase('SCHEDULED', STARTS_AT, ENDS_AT, STARTS_AT)).toBe('OPEN');
  });

  it('is OPEN inside the window for both non-terminal statuses', () => {
    expect(competitionLifecyclePhase('SCHEDULED', STARTS_AT, ENDS_AT, new Date('2026-01-01T12:00:00.000Z'))).toBe('OPEN');
    expect(competitionLifecyclePhase('ACTIVE', STARTS_AT, ENDS_AT, new Date('2026-01-01T12:00:00.000Z'))).toBe('OPEN');
  });

  it('is OPEN exactly at endsAt (exact end boundary)', () => {
    expect(competitionLifecyclePhase('SCHEDULED', STARTS_AT, ENDS_AT, ENDS_AT)).toBe('OPEN');
  });

  it('is ENDED after endsAt', () => {
    expect(
      competitionLifecyclePhase('SCHEDULED', STARTS_AT, ENDS_AT, new Date('2026-01-02T00:00:01.000Z'))
    ).toBe('ENDED');
    expect(competitionLifecyclePhase('ACTIVE', STARTS_AT, ENDS_AT, new Date('2026-06-01T00:00:00.000Z'))).toBe('ENDED');
  });

  it('persisted COMPLETED overrides timestamps in every window', () => {
    expect(competitionLifecyclePhase('COMPLETED', STARTS_AT, ENDS_AT, new Date('2025-01-01T00:00:00.000Z'))).toBe('COMPLETED');
    expect(competitionLifecyclePhase('COMPLETED', STARTS_AT, ENDS_AT, new Date('2026-01-01T12:00:00.000Z'))).toBe('COMPLETED');
    expect(competitionLifecyclePhase('COMPLETED', STARTS_AT, ENDS_AT, new Date('2026-12-01T00:00:00.000Z'))).toBe('COMPLETED');
  });

  it('persisted CANCELLED overrides timestamps in every window', () => {
    expect(competitionLifecyclePhase('CANCELLED', STARTS_AT, ENDS_AT, new Date('2025-01-01T00:00:00.000Z'))).toBe('CANCELLED');
    expect(competitionLifecyclePhase('CANCELLED', STARTS_AT, ENDS_AT, new Date('2026-01-01T12:00:00.000Z'))).toBe('CANCELLED');
    expect(competitionLifecyclePhase('CANCELLED', STARTS_AT, ENDS_AT, new Date('2026-12-01T00:00:00.000Z'))).toBe('CANCELLED');
  });
});

describe('competitionLifecycleInfo', () => {
  it('derives phase and isFull together', () => {
    const info = competitionLifecycleInfo(
      {
        status: 'SCHEDULED',
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
        maxParticipants: 10,
        participantCount: 10,
      },
      new Date('2026-01-01T12:00:00.000Z')
    );
    expect(info).toEqual({ phase: 'OPEN', isFull: true });
  });

  it('is not full below the cap or when no cap exists', () => {
    const below = competitionLifecycleInfo(
      { status: 'SCHEDULED', startsAt: STARTS_AT, endsAt: ENDS_AT, maxParticipants: 10, participantCount: 9 },
      new Date('2026-01-01T12:00:00.000Z')
    );
    const unlimited = competitionLifecycleInfo(
      { status: 'SCHEDULED', startsAt: STARTS_AT, endsAt: ENDS_AT, maxParticipants: null, participantCount: 500 },
      new Date('2026-01-01T12:00:00.000Z')
    );
    expect(below).toEqual({ phase: 'OPEN', isFull: false });
    expect(unlimited.isFull).toBe(false);
  });

  it('flags a reached cap even when the competition has not started', () => {
    const upcoming = competitionLifecycleInfo(
      { status: 'SCHEDULED', startsAt: STARTS_AT, endsAt: ENDS_AT, maxParticipants: 3, participantCount: 3 },
      new Date('2025-06-01T00:00:00.000Z')
    );
    expect(upcoming).toEqual({ phase: 'UPCOMING', isFull: true });
  });
});