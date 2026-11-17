import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  HELD_CASE_UPDATE_COLUMNS, HELD_TABLE_CAPABILITIES, verifyHeldRecoveryCapabilities,
} from './held-recovery-capabilities.js';

type Reader = Parameters<typeof verifyHeldRecoveryCapabilities>[0];
const count = HELD_TABLE_CAPABILITIES.length + HELD_CASE_UPDATE_COLUMNS.length;
function reader(failAt = -1, row: unknown = { installed: true, granted: false }) {
  let calls = 0;
  return { $queryRaw: async () => {
    const value = calls++ === failAt ? row : { installed: true, granted: true };
    return value === undefined ? [] : [value];
  } } as unknown as Reader;
}

describe('held-deposit runtime capabilities (synthetic metadata only)', () => {
  it('accepts complete capabilities without demanding UPDATE on immutable case keys', async () => {
    expect(await verifyHeldRecoveryCapabilities(reader(), 'runtime', true)).toEqual([]);
    expect(HELD_CASE_UPDATE_COLUMNS).not.toContain('orderId');
    expect(HELD_TABLE_CAPABILITIES).toContainEqual(['held_deposit_recovery_policy', 'SELECT']);
  });
  for (let i = 0; i < count; i++) {
    it(`fails closed when required capability ${i} is absent or ungranted`, async () => {
      for (const row of [{ installed: true, granted: false }, { installed: true, granted: null },
        { installed: false, granted: null }]) {
        expect(await verifyHeldRecoveryCapabilities(reader(i, row), 'runtime', true)).toHaveLength(1);
      }
    });
  }
  it('allows historical owner fixtures only when a relation is genuinely absent', async () => {
    expect(await verifyHeldRecoveryCapabilities(reader(0, { installed: false, granted: null }), 'runtime', false)).toEqual([]);
    expect(await verifyHeldRecoveryCapabilities(reader(0), 'runtime', false)).toHaveLength(1);
  });
  it('rejects empty metadata results', async () => {
    const tx = { $queryRaw: async () => [] } as unknown as Reader;
    expect(await verifyHeldRecoveryCapabilities(tx, 'runtime', true)).toHaveLength(count);
    expect(await verifyHeldRecoveryCapabilities(tx, 'runtime', false)).toHaveLength(count);
  });
  it('propagates metadata errors instead of allowing deployment', async () => {
    const tx = { $queryRaw: async () => { throw new Error('metadata unavailable'); } } as unknown as Reader;
    await expect(verifyHeldRecoveryCapabilities(tx, 'runtime', true)).rejects.toThrow('metadata unavailable');
  });
  it('is wired into both owner setup and strict predeploy shared capabilities', () => {
    const source = readFileSync(new URL('./ledger-runtime-access.ts', import.meta.url), 'utf8');
    expect(source).toContain('verifyHeldRecoveryCapabilities(tx, role, requirePractice)');
    expect(source).toContain('requiredPrivileges(tx, role, true)');
    expect(source).toContain('requiredPrivileges(tx, role, false)');
  });
});
