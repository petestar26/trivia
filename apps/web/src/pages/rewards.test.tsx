import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const listTasks = vi.fn();
const listAchievements = vi.fn();
const getVip = vi.fn();
const getProgress = vi.fn();
const claimTaskReward = vi.fn();
const toastMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    listTasks: (...a: unknown[]) => listTasks(...a),
    listAchievements: (...a: unknown[]) => listAchievements(...a),
    getVip: (...a: unknown[]) => getVip(...a),
    getProgress: (...a: unknown[]) => getProgress(...a),
    claimTaskReward: (...a: unknown[]) => claimTaskReward(...a),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: (...a: unknown[]) => toastMock(...a) }) }));

import { RewardsPage } from './rewards';

afterEach(() => {
  cleanup();
  listTasks.mockReset();
  listAchievements.mockReset();
  getVip.mockReset();
  getProgress.mockReset();
  claimTaskReward.mockReset();
  toastMock.mockReset();
});

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function renderPage(client: QueryClient = createClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<RewardsPage />, { wrapper });
}

/**
 * Default filler responses so the page passes its loading gate. Must be
 * called BEFORE a test overrides listTasks/listAchievements so the override
 * wins; stubbing the aggregates here keeps the loading level passable and the
 * top-level error state silent in tests that isolate a single axis.
 */
function stubSupportingQueries() {
  listTasks.mockResolvedValue({ success: true, data: [] });
  listAchievements.mockResolvedValue({ success: true, data: [] });
  getVip.mockResolvedValue({ success: true, data: { isActive: false, tier: 'SILVER' } });
  getProgress.mockResolvedValue({ success: true, data: { level: 1, xp: 0 } });
}

const COMPLETED_TASK = {
  // Real values from the task catalog (`task-service.ts`): daily_login, 10 XP,
  // 0 Coins, 5 Game Points. The claim endpoint keys off the TaskDefinition id.
  id: '11111111-1111-1111-1111-111111111111',
  key: 'daily_login',
  type: 'DAILY',
  title: 'Daily Login',
  description: 'Log in today',
  target: 1,
  xpReward: 10,
  coinReward: 0,
  gamePointReward: 5,
  progress: 1,
  status: 'COMPLETED',
};

// Regression: `api.listTasks()` returns ApiResponse, so `.data` in the
// queryFn already yields the array. The page then unwrapped `.data` a second
// time off that array, which is always `undefined` — so every task list
// rendered as "No tasks available." regardless of what the API returned.
describe('RewardsPage — tasks', () => {
  it('renders tasks returned by the API instead of the empty state', async () => {
    stubSupportingQueries();
    listTasks.mockResolvedValue({ success: true, data: [COMPLETED_TASK] });

    renderPage();

    expect(await screen.findByText('Daily Login')).toBeInTheDocument();
    expect(screen.getByText('Log in today')).toBeInTheDocument();
    expect(screen.queryByText('No tasks available.')).not.toBeInTheDocument();
    // Reward line renders the real daily_login payload (5 GP, no coins).
    expect(screen.getByText(/5 GP/)).toBeInTheDocument();
  });

  it('still shows the empty state when the API genuinely returns no tasks', async () => {
    stubSupportingQueries();
    listTasks.mockResolvedValue({ success: true, data: [] });

    renderPage();

    expect(await screen.findByText('No tasks available.')).toBeInTheDocument();
  });
});

// Regression: identical double unwrap for achievements.
describe('RewardsPage — achievements', () => {
  it('renders unlocked achievements returned by the API instead of the empty state', async () => {
    stubSupportingQueries();
    // Real achievement catalog (`achievement-service.ts`): first_message.
    listAchievements.mockResolvedValue({
      success: true,
      data: [
        {
          key: 'first_message',
          title: 'First Message',
          category: 'CHAT',
          description: 'Sent your first message',
          unlockedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    renderPage();

    expect(await screen.findByText('First Message')).toBeInTheDocument();
    expect(screen.getByText('Sent your first message')).toBeInTheDocument();
    expect(screen.queryByText('No achievements unlocked yet.')).not.toBeInTheDocument();
  });

  it('still shows the empty state when the API genuinely returns no achievements', async () => {
    stubSupportingQueries();
    listAchievements.mockResolvedValue({ success: true, data: [] });

    renderPage();

    expect(await screen.findByText('No achievements unlocked yet.')).toBeInTheDocument();
  });
});

describe('RewardsPage — claim', () => {
  it('claims using the TaskDefinition ID returned by the API', async () => {
    stubSupportingQueries();
    listTasks.mockResolvedValue({ success: true, data: [COMPLETED_TASK] });
    claimTaskReward.mockResolvedValue({ success: true, data: { granted: true } });

    renderPage();

    const claimButton = await screen.findByRole('button', { name: 'Claim' });
    fireEvent.click(claimButton);

    await waitFor(() => expect(claimTaskReward).toHaveBeenCalledTimes(1));
    // The claim endpoint keys off the TaskDefinition id (def.id), which is
    // the very `id` the API returned in the task list.
    expect(claimTaskReward).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
  });

  it('invalidates the tasks, wallet balance, and wallet-transaction caches on success', async () => {
    stubSupportingQueries();
    listTasks.mockResolvedValue({ success: true, data: [COMPLETED_TASK] });
    claimTaskReward.mockResolvedValue({ success: true, data: { granted: true } });

    const client = createClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);

    const claimButton = await screen.findByRole('button', { name: 'Claim' });
    fireEvent.click(claimButton);

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({ title: 'Reward claimed!' }));

    // A successful monetary claim must refresh the task list plus both wallet
    // cache families. `['wallet']` keeps its partial-key semantics, matching
    // e.g. `['wallet', userId]`.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }))
    );
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));

    // Exactly one claim request; the tasks query re-fetches after invalidation.
    expect(claimTaskReward).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listTasks.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('does not issue concurrent claims while a claim is pending', async () => {
    stubSupportingQueries();
    listTasks.mockResolvedValue({ success: true, data: [COMPLETED_TASK] });
    let resolveClaim: ((value: unknown) => void) | undefined;
    claimTaskReward.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveClaim = resolve;
      });
    });

    renderPage();

    const claimButton = await screen.findByRole('button', { name: 'Claim' });
    fireEvent.click(claimButton);
    await waitFor(() => expect(claimTaskReward).toHaveBeenCalledTimes(1));

    // While the first claim is in-flight the button is disabled.
    await waitFor(() => expect(claimButton).toBeDisabled());
    fireEvent.click(claimButton);

    expect(claimTaskReward).toHaveBeenCalledTimes(1);
    resolveClaim?.({ success: true, data: { granted: true } });
    await waitFor(() => expect(claimButton).not.toBeDisabled());
  });

  it('surfaces flattened JSON error messages through getErrorMessage', async () => {
    stubSupportingQueries();
    listTasks.mockResolvedValue({ success: true, data: [COMPLETED_TASK] });
    claimTaskReward.mockRejectedValue(
      new Error(JSON.stringify({ status: 400, code: 'TASK_NOT_COMPLETED', message: 'Task is not completed yet' }))
    );

    renderPage();

    const claimButton = await screen.findByRole('button', { name: 'Claim' });
    fireEvent.click(claimButton);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Task is not completed yet',
        variant: 'destructive',
      })
    );
  });

  it('surfaces nested error.message payloads through getErrorMessage', async () => {
    stubSupportingQueries();
    listTasks.mockResolvedValue({ success: true, data: [COMPLETED_TASK] });
    claimTaskReward.mockRejectedValue(new Error(JSON.stringify({ error: { code: 'X', message: 'Nested claim error' } })));

    renderPage();

    const claimButton = await screen.findByRole('button', { name: 'Claim' });
    fireEvent.click(claimButton);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Nested claim error',
        variant: 'destructive',
      })
    );
  });

  it('surfaces plain-text Errors (no JSON) through getErrorMessage', async () => {
    stubSupportingQueries();
    listTasks.mockResolvedValue({ success: true, data: [COMPLETED_TASK] });
    claimTaskReward.mockRejectedValue(new Error('Failed to fetch'));

    renderPage();

    const claimButton = await screen.findByRole('button', { name: 'Claim' });
    fireEvent.click(claimButton);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Failed to fetch',
        variant: 'destructive',
      })
    );
  });

  it('does not crash on malformed/plain non-JSON, rendering text through getErrorMessage', async () => {
    stubSupportingQueries();
    listTasks.mockResolvedValue({ success: true, data: [COMPLETED_TASK] });

    // getErrorMessage treats a value that fails JSON.parse as a plain error
    // message and returns that original text verbatim (as it does for
    // "Failed to fetch"); nothing is hidden or silently replaced.
    claimTaskReward.mockRejectedValue(new Error('{definitely not json'));

    renderPage();

    const claimButton = await screen.findByRole('button', { name: 'Claim' });
    fireEvent.click(claimButton);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Error',
        description: '{definitely not json',
        variant: 'destructive',
      })
    );
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});