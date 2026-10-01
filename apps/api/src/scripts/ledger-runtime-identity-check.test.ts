import { describe, expect, it } from 'vitest';
import { verifyLedgerRuntimeIdentity } from './ledger-runtime-identity-check.js';

const restricted = {
  role: 'playqube_app', rolsuper: false, rolbypassrls: false, key_read: false,
  migration_insert: false, migration_update: false, migration_delete: false,
};

function reader(rows: unknown[]) {
  return { $queryRawUnsafe: async <T>() => rows as T };
}

describe('predeploy runtime identity', () => {
  it('accepts only the named role without owner or migration rights', async () => {
    await expect(verifyLedgerRuntimeIdentity(reader([restricted]), 'playqube_app')).resolves.toBeUndefined();
    for (const change of [
      { role: 'postgres' }, { rolsuper: true }, { rolbypassrls: true }, { key_read: true },
      { migration_insert: true }, { migration_update: true }, { migration_delete: true },
      { key_read: null }, { migration_insert: null },
    ]) {
      await expect(verifyLedgerRuntimeIdentity(reader([{ ...restricted, ...change }]), 'playqube_app'))
        .rejects.toThrow('runtime identity verification failed');
    }
  });

  it('rejects missing, ambiguous or unsafe expected roles', async () => {
    for (const rows of [[], [restricted, restricted]]) {
      await expect(verifyLedgerRuntimeIdentity(reader(rows), 'playqube_app'))
        .rejects.toThrow('runtime identity verification failed');
    }
    await expect(verifyLedgerRuntimeIdentity(reader([restricted]), 'playqube_app;DROP ROLE'))
      .rejects.toThrow('runtime identity verification failed');
  });
});
