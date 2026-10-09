import { describe, expect, it, vi } from 'vitest';
import { VF_TIMING, cycleByIndex } from '@socialplay/shared';
import { createFootballService } from './service.js';

/** A fake database whose clock we control; any insert path would call $transaction. */
function fakeDb(nowMs: number, existing = false) {
  const transaction = vi.fn(async () => undefined);
  const queryRaw = vi.fn(async (parts: TemplateStringsArray) => {
    const sql = parts.join('?');
    if (sql.includes('clock_timestamp')) return [{ now: new Date(nowMs) }];
    if (sql.includes('FROM football_matchweeks WHERE id=')) return existing ? [{ id: 'x' }] : [];
    return [];
  });
  return { db: { $queryRaw: queryRaw, $transaction: transaction } as never, transaction, queryRaw };
}
const cycle = cycleByIndex(100);

describe('matchweek creation window', () => {
  it('creates nothing before the league anchor', async () => {
    const { db, transaction } = fakeDb(VF_TIMING.anchorMs - 1);
    await createFootballService(db).ensureMatchweek();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['exactly at kickoff', cycle.kickoffAt],
    ['during the first half', cycle.kickoffAt + 5_000],
    ['at half-time', cycle.halftimeAt],
    ['in the second half', cycle.secondHalfAt + 10_000],
    ['at full time', cycle.fullTimeAt],
    ['in the results window', cycle.fullTimeAt + 5_000],
    ['at the last millisecond of the cycle', cycle.endsAt - 1],
  ])('never creates a missed week %s (no retroactive commitment)', async (_name, at) => {
    const { db, transaction } = fakeDb(at);
    await createFootballService(db).ensureMatchweek();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['the instant the window opens', cycle.opensAt],
    ['mid-window', cycle.opensAt + 100_000],
    ['the last millisecond before kickoff', cycle.kickoffAt - 1],
  ])('attempts creation %s', async (_name, at) => {
    const { db, transaction } = fakeDb(at);
    await createFootballService(db).ensureMatchweek();
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('does not try again once the week already exists', async () => {
    const { db, transaction } = fakeDb(cycle.opensAt + 1_000, true);
    await createFootballService(db).ensureMatchweek();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('treats a window that closed during the insert as a missed week, but surfaces real failures', async () => {
    const closed = fakeDb(cycle.kickoffAt - 1);
    closed.transaction.mockRejectedValueOnce(new Error('Football matchweek can only be committed during its selection window'));
    await expect(createFootballService(closed.db).ensureMatchweek()).resolves.toBeUndefined();
    const broken = fakeDb(cycle.opensAt + 1_000);
    broken.transaction.mockRejectedValueOnce(new Error('connection refused'));
    await expect(createFootballService(broken.db).ensureMatchweek()).rejects.toThrow('connection refused');
  });

  it('reports a creation failure from the worker tick without stopping settlement', async () => {
    const { db, transaction } = fakeDb(cycle.opensAt + 1_000);
    transaction.mockRejectedValueOnce(new Error('boom'));
    const errors: string[] = [];
    await createFootballService(db).tick((id) => errors.push(id));
    expect(errors).toEqual(['ensure-matchweek']);
  });
});
