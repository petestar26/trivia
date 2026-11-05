import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemberRewardsPage } from './member-rewards';
import { ProfilePage } from './profile';
import { RewardControlPage } from './workspaces/reward-control';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  api: mocks,
  unwrapData: (r: { success: boolean; data?: unknown }) => {
    if (!r.success) throw new Error('Unavailable');
    return r.data;
  },
}));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'member-1' }, refreshUser: mocks.refresh, logout: vi.fn() }),
}));
vi.mock('@/components/security/authenticator-setup', () => ({
  AuthenticatorSetup: () => <div>Authenticator settings</div>,
}));
vi.mock('@/lib/practice-etb', () => ({ PRACTICE_ETB: true }));
const config = {
  version: 1,
  daily_enabled: true,
  daily_amount: 250,
  gift_enabled: true,
  gift_amount: 500,
  gift_daily_limit: 1000,
  referral_enabled: true,
  referral_amount: 2000,
  gift_minimum: 10000,
  updated_at: '2026-11-05T00:00:00Z',
};
let rewards: any;
let profile: any;
beforeEach(() => {
  rewards = {
    config,
    wallet: { coinAvailability: { betOnly: 2500, spendable: 1600, pendingReview: 0, reserved: 0 } },
    eligibility: { canClaim: false, expiryHours: null },
    referralCode: 'ABCD2345',
    referrals: 2,
    qualifiedReferrals: 1,
    pendingMinor: 250,
    earnedMinor: 2750,
    today: null,
    day: '2026-11-05',
    nextCheckInAt: '2026-11-05T21:00:00Z',
    history: [
      {
        id: 'reward-1',
        kind: 'DAILY',
        amount: 250,
        created_at: '2026-11-05T00:00:00Z',
        claimed_at: null,
      },
    ],
    hasMore: false,
  };
  profile = {
    id: 'member-1',
    username: 'peter',
    displayName: 'Peter',
    bio: 'Hello',
    avatarUrl: null,
    email: null,
    phone: '+251911000001',
    phoneVerified: false,
    isVerified: false,
    role: 'USER',
    status: 'ACTIVE',
    createdAt: '2026-01-01',
    lastLoginAt: null,
    signInMethods: ['PHONE'],
    payoutCountry: null,
    kycVerification: null,
  };
  mocks.get.mockImplementation(async (path: string) => ({
    success: true,
    data:
      path === '/member-profile'
        ? profile
        : path === '/member-rewards/admin'
          ? { config, history: [], gates: [] }
          : rewards,
  }));
  mocks.post.mockResolvedValue({ success: true, data: { id: 'new-reward' } });
  mocks.patch.mockResolvedValue({ success: true, data: { saved: true } });
  mocks.put.mockResolvedValue({ success: true, data: config });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function show(page: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>
  );
}
it('separates bonus and cash, explains practice exclusion, and shares a referral link', async () => {
  show(<MemberRewardsPage />);
  expect(
    await screen.findByRole('heading', { name: 'Rewards, made for you.' })
  ).toBeInTheDocument();
  expect(screen.getByText('25.00 ETB')).toBeInTheDocument();
  expect(screen.getByText('16.00 ETB')).toBeInTheDocument();
  expect(screen.getByText(/current gift shop uses practice ETB/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Your code/)).toHaveValue(
    'http://localhost:3000/register?ref=ABCD2345'
  );
  expect(screen.getByText('Processing automatically')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /claim|check in/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Daily Tasks' })).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/\bGP\b|waiting.*admin|awaiting.*admin/i);
});
it('explains automatic delivery while the reward wallet is unavailable', async () => {
  show(<MemberRewardsPage />);
  expect(
    await screen.findByText(
      /They will be credited automatically when your reward wallet is available/
    )
  ).toBeInTheDocument();
  expect(mocks.post).not.toHaveBeenCalled();
});
it('shows automatic credit status and neutral unavailable rates without admin wording', async () => {
  rewards.eligibility.canClaim = true;
  rewards.today = { id: 'reward-1', claimed_at: '2026-11-05T00:00:00Z' };
  rewards.history[0].claimed_at = rewards.today.claimed_at;
  rewards.config = {
    ...config,
    daily_enabled: false,
    gift_enabled: false,
    referral_enabled: false,
  };
  show(<MemberRewardsPage />);
  expect(await screen.findByText('Today’s reward credited')).toBeInTheDocument();
  expect(screen.getByText('Credited')).toBeInTheDocument();
  expect(screen.getAllByText('Currently unavailable')).toHaveLength(3);
  expect(document.body.textContent).not.toMatch(/\badmin\b|\bGP\b|claim/i);
  expect(mocks.post).not.toHaveBeenCalled();
});
it('shows phone-only account information accurately and saves only editable profile fields', async () => {
  show(<ProfilePage />);
  expect(await screen.findByText('+251911000001 · Not verified')).toBeInTheDocument();
  expect(screen.getByText('Not configured')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Peter Updated' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(mocks.patch).toHaveBeenCalledWith('/member-profile', {
      displayName: 'Peter Updated',
      bio: 'Hello',
    })
  );
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
});
it('admin controls save exact Birr cents and include the current settings version', async () => {
  show(<RewardControlPage />);
  const amount = await screen.findByLabelText('Daily reward (Birr)');
  expect(screen.getByText(/Set these rates once for the whole platform/)).toBeInTheDocument();
  fireEvent.change(amount, { target: { value: '12.34' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save reward settings' }));
  await waitFor(() =>
    expect(mocks.put).toHaveBeenCalledWith(
      '/member-rewards/admin',
      expect.objectContaining({ version: 1, daily_amount: 1234, referral_amount: 2000 })
    )
  );
});
it('admin controls reject fractional cents before submitting', async () => {
  show(<RewardControlPage />);
  fireEvent.change(await screen.findByLabelText('Daily reward (Birr)'), {
    target: { value: '1.001' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save reward settings' }));
  expect(await screen.findByText(/no more than two decimal places/)).toBeInTheDocument();
  expect(mocks.put).not.toHaveBeenCalled();
});
