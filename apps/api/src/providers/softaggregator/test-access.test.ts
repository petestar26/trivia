import { expect, it } from 'vitest';
import { testAccess, testAccessMode } from './test-wallet.js';

const settings = { SOFTAGGREGATOR_TEST_ENABLED: 'true', SOFTAGGREGATOR_DEMO_USER_IDS: 'original' };

it('keeps existing installations restricted until automatic access is explicitly enabled', () => {
  expect(testAccessMode(settings)).toBe('allowlist');
  expect(testAccess(settings, 'original')).toBe(true);
  expect(testAccess(settings, 'new-member')).toBe(false);
  expect(testAccess({ ...settings, SOFTAGGREGATOR_TEST_USER_IDS: '' }, 'original')).toBe(false);
});

it('automatically includes future member IDs without a tester list', () => {
  const env = {
    SOFTAGGREGATOR_TEST_ENABLED: 'true',
    SOFTAGGREGATOR_TEST_ACCESS_MODE: 'all-active',
  };
  expect(testAccess(env, 'existing-member')).toBe(true);
  expect(testAccess(env, 'future-signup')).toBe(true);
  expect(testAccess(env, '')).toBe(false);
  expect(testAccess(env, '   ')).toBe(false);
  expect(testAccess({ ...env, SOFTAGGREGATOR_TEST_ENABLED: 'false' }, 'existing-member')).toBe(
    false
  );
});

it.each(['all', '*', '', 'ALL-ACTIVE'])(
  'fails closed for an unsupported access mode %j',
  (mode) => {
    const env = { ...settings, SOFTAGGREGATOR_TEST_ACCESS_MODE: mode };
    expect(testAccessMode(env)).toBe('invalid');
    expect(testAccess(env, 'original')).toBe(false);
    expect(testAccess(env, 'new-member')).toBe(false);
  }
);
