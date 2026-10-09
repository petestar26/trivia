import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const state = vi.hoisted(() => ({
  owner: true,
  safe: true,
  grants: true,
  pending: false,
  failed: false,
  checksum: true,
  unrelated: false,
  names: ['20261009120000_thunder_derby_practice'],
  game: {
    isActive: false,
    catalogStatus: 'COMING_SOON',
    mode: 'WAGER',
    wagerCurrency: 'COINS',
    rewardCurrency: 'COINS',
  },
  execute: vi.fn(),
  grant: vi.fn(),
  disconnect: vi.fn(),
  construct: vi.fn(),
}));
vi.mock('node:fs', () => ({
  readFileSync: () => Buffer.from('fixture SQL'),
  readdirSync: () => (state.unrelated ? [...state.names, '20261009130000_unrelated'] : state.names),
}));
vi.mock('node:child_process', () => ({ execFileSync: state.execute }));
vi.mock('./derby-runtime-grants.js', () => ({ grantDerbyRuntimeTables: state.grant }));
vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor() {
      state.construct();
    }
    $disconnect = state.disconnect;
    gameDefinition = { findUnique: async () => state.game };
    async $queryRaw(parts: TemplateStringsArray) {
      const sql = parts.join('?');
      if (sql.includes('pg_catalog.pg_database')) return [{ allowed: state.owner }];
      if (sql.includes('FROM pg_roles')) return [{ allowed: state.safe }];
      if (sql.includes('has_column_privilege')) return [{ allowed: state.grants }];
      if (sql.includes('_prisma_migrations'))
        return state.pending
          ? []
          : [
              {
                migration_name: state.names[0],
                checksum: state.checksum
                  ? createHash('sha256').update('fixture SQL').digest('hex')
                  : 'bad',
                finished_at: state.failed ? null : new Date(),
                rolled_back_at: null,
              },
            ];
      throw Error('Unexpected SQL');
    }
  },
}));
import { runDerbyStagingUpgrade } from './staging-derby-upgrade.js';
const env = {
  RAILWAY_ENVIRONMENT_ID: '7de0c716-24df-4e97-a998-ed99abfa256f',
  PRACTICE_STAGING_ACK: 'spin-practice-rehearsal-20261002',
  DATABASE_URL:
    'postgresql://owner:fixture@spin-practice-db-20261002.railway.internal/playqube_spin_rehearsal_20261002',
  SOCIAL_WORKER_DATABASE_URL:
    'postgresql://derby_worker:fixture@spin-practice-db-20261002.railway.internal/playqube_spin_rehearsal_20261002',
  PRACTICE_API_ROLE: 'spin_rehearsal_api_fixture',
};
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    owner: true,
    safe: true,
    grants: true,
    pending: false,
    failed: false,
    checksum: true,
    unrelated: false,
  });
  state.game.isActive = false;
});
it.each(['RAILWAY_ENVIRONMENT_ID', 'PRACTICE_STAGING_ACK', 'DATABASE_URL', 'PRACTICE_API_ROLE'])(
  'refuses wrong %s before connecting',
  async (key) => {
    await expect(runDerbyStagingUpgrade({ ...env, [key]: 'wrong' }, true)).rejects.toThrow();
    expect(state.construct).not.toHaveBeenCalled();
  }
);
it.each([
  env.SOCIAL_WORKER_DATABASE_URL.replace('railway.internal', 'example.com'),
  env.SOCIAL_WORKER_DATABASE_URL.replace('/playqube_spin_rehearsal_20261002', '/production'),
  env.SOCIAL_WORKER_DATABASE_URL.replace('railway.internal', 'railway.internal:5433'),
  env.SOCIAL_WORKER_DATABASE_URL.replace('derby_worker', 'bad%22role'),
])('refuses a mismatched worker target', async (url) => {
  await expect(
    runDerbyStagingUpgrade({ ...env, SOCIAL_WORKER_DATABASE_URL: url }, true)
  ).rejects.toThrow('WORKER_TARGET_REFUSED');
  expect(state.construct).not.toHaveBeenCalled();
});
it.each(['owner', 'safe', 'checksum', 'failed', 'unrelated', 'catalog'])(
  'refuses unsafe %s without mutations',
  async (kind) => {
    if (kind === 'catalog') state.game.isActive = true;
    else if (kind === 'failed' || kind === 'unrelated') state[kind] = true;
    else state[kind as 'owner' | 'safe' | 'checksum'] = false;
    await expect(runDerbyStagingUpgrade(env, true)).rejects.toThrow();
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.grant).not.toHaveBeenCalled();
    expect(state.disconnect).toHaveBeenCalledOnce();
  }
);
it('dry-run verifies existing grants but makes no writes', async () => {
  await runDerbyStagingUpgrade(env);
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();
});
it('dry-run refuses pending migration and missing grants', async () => {
  state.pending = true;
  await expect(runDerbyStagingUpgrade(env)).rejects.toThrow('DERBY_MIGRATION_NOT_APPLIED');
  state.pending = false;
  state.grants = false;
  await expect(runDerbyStagingUpgrade(env)).rejects.toThrow('DERBY_RUNTIME_GRANTS_MISSING');
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();
});
it('explicit apply deploys only the allowed migration and grants both roles', async () => {
  state.pending = true;
  await runDerbyStagingUpgrade(env, true);
  expect(state.execute).toHaveBeenCalledOnce();
  expect(state.grant.mock.calls.map((call) => call[1])).toEqual([
    env.PRACTICE_API_ROLE,
    'derby_worker',
  ]);
});
