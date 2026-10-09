import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const FOOTBALL = [
  '20261010010000_virtual_football_game_type',
  '20261010010100_virtual_football_practice',
  '20261010010200_virtual_football_catalog',
];
const DERBY = '20261009120000_thunder_derby_practice';
const state = vi.hoisted(() => ({
  owner: true,
  safe: true,
  grants: true,
  excess: false,
  pendingFootball: false,
  pendingDerby: false,
  failed: false,
  checksum: true,
  unrelated: false,
  derbyRow: {
    isActive: false,
    catalogStatus: 'COMING_SOON',
    mode: 'WAGER',
    wagerCurrency: 'COINS',
    rewardCurrency: 'COINS',
  } as Record<string, unknown> | null,
  footballRow: {
    isActive: false,
    catalogStatus: 'COMING_SOON',
    mode: 'WAGER',
    wagerCurrency: 'COINS',
    rewardCurrency: 'COINS',
  } as Record<string, unknown> | null,
  execute: vi.fn(),
  grant: vi.fn(),
  disconnect: vi.fn(),
  construct: vi.fn(),
}));
vi.mock('node:fs', () => ({
  readFileSync: () => Buffer.from('fixture SQL'),
  readdirSync: () => [DERBY, ...FOOTBALL, ...(state.unrelated ? ['20261011000000_unrelated'] : [])],
}));
vi.mock('node:child_process', () => ({ execFileSync: state.execute }));
vi.mock('./football-runtime-grants.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  grantFootballRuntimeTables: state.grant,
}));
vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor() {
      state.construct();
    }
    $disconnect = state.disconnect;
    gameDefinition = {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === 'virtual_football_3d' ? state.footballRow : state.derbyRow,
    };
    async $queryRaw(parts: TemplateStringsArray, ...values: unknown[]) {
      const sql = parts.join('?');
      if (sql.includes('pg_catalog.pg_database')) return [{ allowed: state.owner }];
      if (sql.includes('FROM pg_roles')) return [{ allowed: state.safe }];
      if (sql.includes('has_table_privilege')) {
        const [, table, privilege] = values as [string, string, string];
        const required = (
          await import('./football-runtime-grants.js')
        ).FOOTBALL_RUNTIME_GRANTS.some(([t, p]) => `public.${t}` === table && p === privilege);
        return [{ allowed: required ? state.grants : state.excess }];
      }
      if (sql.includes('_prisma_migrations')) {
        const done = (name: string) => ({
          migration_name: name,
          checksum: state.checksum
            ? createHash('sha256').update('fixture SQL').digest('hex')
            : 'bad',
          finished_at: state.failed ? null : new Date(),
          rolled_back_at: null,
        });
        return [
          ...(state.pendingDerby ? [] : [done(DERBY)]),
          ...(state.pendingFootball ? [] : FOOTBALL.map(done)),
        ];
      }
      throw Error('Unexpected SQL');
    }
  },
}));
import {
  FOOTBALL_FORBIDDEN_PRIVILEGES,
  FOOTBALL_RUNTIME_GRANTS,
} from './football-runtime-grants.js';
import { FOOTBALL_MIGRATIONS, runFootballStagingUpgrade } from './staging-football-upgrade.js';

const env = {
  RAILWAY_ENVIRONMENT_ID: '7de0c716-24df-4e97-a998-ed99abfa256f',
  PRACTICE_STAGING_ACK: 'spin-practice-rehearsal-20261002',
  DATABASE_URL:
    'postgresql://owner:fixture@spin-practice-db-20261002.railway.internal/playqube_spin_rehearsal_20261002',
  SOCIAL_WORKER_DATABASE_URL:
    'postgresql://football_worker:fixture@spin-practice-db-20261002.railway.internal/playqube_spin_rehearsal_20261002',
  PRACTICE_API_ROLE: 'spin_rehearsal_api_fixture',
};
const base = { derbyRow: state.derbyRow, footballRow: state.footballRow };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    owner: true,
    safe: true,
    grants: true,
    excess: false,
    pendingFootball: false,
    pendingDerby: false,
    failed: false,
    checksum: true,
    unrelated: false,
    derbyRow: { ...base.derbyRow },
    footballRow: { ...base.footballRow },
  });
});

it('allow-lists exactly the three football migrations and nothing else', () => {
  expect(FOOTBALL_MIGRATIONS).toEqual(FOOTBALL);
});

it.each(['RAILWAY_ENVIRONMENT_ID', 'PRACTICE_STAGING_ACK', 'DATABASE_URL', 'PRACTICE_API_ROLE'])(
  'refuses wrong %s before connecting',
  async (key) => {
    await expect(runFootballStagingUpgrade({ ...env, [key]: 'wrong' }, true)).rejects.toThrow();
    expect(state.construct).not.toHaveBeenCalled();
  }
);

it.each([
  env.SOCIAL_WORKER_DATABASE_URL.replace('railway.internal', 'example.com'),
  env.SOCIAL_WORKER_DATABASE_URL.replace('/playqube_spin_rehearsal_20261002', '/production'),
  env.SOCIAL_WORKER_DATABASE_URL.replace('railway.internal', 'railway.internal:5433'),
  env.SOCIAL_WORKER_DATABASE_URL.replace('football_worker', 'bad%22role'),
])('refuses a mismatched worker target', async (url) => {
  await expect(
    runFootballStagingUpgrade({ ...env, SOCIAL_WORKER_DATABASE_URL: url }, true)
  ).rejects.toThrow('WORKER_TARGET_REFUSED');
  expect(state.construct).not.toHaveBeenCalled();
});

it.each(['owner', 'safe', 'checksum', 'failed', 'unrelated', 'derbyCatalog', 'derbyMissing'])(
  'refuses unsafe %s without any mutation',
  async (kind) => {
    state.pendingFootball = true;
    if (kind === 'derbyCatalog') state.derbyRow = { ...state.derbyRow!, isActive: true };
    else if (kind === 'derbyMissing') state.derbyRow = null;
    else if (kind === 'failed' || kind === 'unrelated') state[kind] = true;
    else state[kind as 'owner' | 'safe' | 'checksum'] = false;
    await expect(runFootballStagingUpgrade(env, true)).rejects.toThrow();
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.grant).not.toHaveBeenCalled();
    expect(state.disconnect).toHaveBeenCalledOnce();
  }
);

it('refuses to absorb the Derby migration: that stays behind its own narrow command', async () => {
  state.pendingDerby = true;
  state.pendingFootball = true;
  await expect(runFootballStagingUpgrade(env, true)).rejects.toThrow('UNRELATED_PENDING_MIGRATION');
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();
});

it('dry-run verifies grants without writing, and refuses pending migrations or missing/excess grants', async () => {
  await runFootballStagingUpgrade(env);
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();
  state.pendingFootball = true;
  await expect(runFootballStagingUpgrade(env)).rejects.toThrow('FOOTBALL_MIGRATION_NOT_APPLIED');
  state.pendingFootball = false;
  state.grants = false;
  await expect(runFootballStagingUpgrade(env)).rejects.toThrow('FOOTBALL_RUNTIME_GRANTS_MISSING');
  state.grants = true;
  state.excess = true;
  await expect(runFootballStagingUpgrade(env)).rejects.toThrow('FOOTBALL_RUNTIME_GRANTS_EXCESSIVE');
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.grant).not.toHaveBeenCalled();
});

it('explicit apply deploys once, grants both roles, and never reports activation', async () => {
  state.pendingFootball = true;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runFootballStagingUpgrade(env, true);
  expect(state.execute).toHaveBeenCalledOnce();
  expect(state.grant.mock.calls.map((call) => call[1])).toEqual([
    env.PRACTICE_API_ROLE,
    'football_worker',
  ]);
  const event = JSON.parse(log.mock.calls.at(-1)![0] as string);
  expect(event).toMatchObject({
    event: 'FOOTBALL_STAGING_READY',
    mode: 'PRACTICE',
    activationPerformed: false,
  });
  log.mockRestore();
});

it('refuses an active or missing football catalog row after migration', async () => {
  state.footballRow = { ...state.footballRow!, isActive: true };
  await expect(runFootballStagingUpgrade(env, true)).rejects.toThrow('FINANCIAL_GATE_INVALID');
  state.footballRow = null;
  await expect(runFootballStagingUpgrade(env, true)).rejects.toThrow('FINANCIAL_GATE_INVALID');
  expect(state.grant).not.toHaveBeenCalled();
});

it('grants never include update or delete on immutable history', () => {
  const granted = new Set(FOOTBALL_RUNTIME_GRANTS.map(([t, p]) => `${t}:${p}`));
  for (const table of ['football_matchweeks', 'football_fixtures', 'football_ticket_legs'])
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(granted.has(`${table}:${privilege}`)).toBe(false);
      expect(FOOTBALL_FORBIDDEN_PRIVILEGES.some(([t, p]) => t === table && p === privilege)).toBe(
        true
      );
    }
  for (const [table, privilege] of FOOTBALL_FORBIDDEN_PRIVILEGES)
    expect(granted.has(`${table}:${privilege}`)).toBe(false);
});
