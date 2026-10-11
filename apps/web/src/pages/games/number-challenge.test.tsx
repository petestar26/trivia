import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NUMBER_TIMED_RULES_ID } from '@socialplay/shared';
import { NumberChallengePage, numberPendingKey } from './number-challenge';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  user: { id: 'member' } as { id: string } | null,
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  api: { get: mocks.get, post: mocks.post },
}));
const round = {
  id: 'round-a',
  guess: 50,
  target: 52,
  away: 2,
  score: 40,
  createdAt: '2026-10-12T00:00:00Z',
  roundId: 'number-v2:29862600',
};
const success = { success: true, data: { receipt: round, isReplay: false } };
function snapshot(offset = 0, target: number | null = null) {
  return {
    rulesId: NUMBER_TIMED_RULES_ID,
    serverNow: new Date(Date.UTC(2026, 9, 12) + offset).toISOString(),
    round: {
      id: 'number-v2:29862600',
      opensAt: '2026-10-12T00:00:00Z',
      closesAt: '2026-10-12T00:00:30Z',
      endsAt: '2026-10-12T00:01:00Z',
      target,
    },
    receipt: null,
    history: [],
  };
}
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>
        <NumberChallengePage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  mocks.user = { id: 'member' };
  mocks.get.mockResolvedValue({ success: true, data: snapshot() });
  mocks.post.mockResolvedValue(success);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.get.mockReset();
  mocks.post.mockReset();
  sessionStorage.clear();
});
it('requires the practice snapshot and valid integers; quick picks and slider respond', async () => {
  mount();
  const reveal = await screen.findByRole('button', { name: 'Place guess' });
  await waitFor(() => expect(reveal).toBeEnabled());
  const input = screen.getByRole('spinbutton');
  for (const value of ['', '0', '101', '50.5']) {
    fireEvent.change(input, { target: { value } });
    expect(reveal).toBeDisabled();
  }
  fireEvent.click(screen.getByRole('button', { name: /^25$/ }));
  expect(input).toHaveValue(25);
  fireEvent.click(screen.getByRole('button', { name: 'Increase number' }));
  expect(input).toHaveValue(26);
  fireEvent.change(screen.getByRole('slider'), { target: { value: '75' } });
  expect(input).toHaveValue(75);
  expect(mocks.post).not.toHaveBeenCalled();
});
it('persists the exact request before sending and renders the confirmed score without wallet calls', async () => {
  mocks.post.mockImplementation(async (_url, entry) => {
    expect(JSON.parse(sessionStorage.getItem(numberPendingKey('member'))!)).toEqual(entry);
    return success;
  });
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Place guess' }));
  expect(await screen.findByText('40 practice score')).toBeInTheDocument();
  expect(screen.getByRole('table')).toHaveTextContent('52');
  expect(sessionStorage.getItem(numberPendingKey('member'))).toBeNull();
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post.mock.calls[0][0]).toBe('/games/number-challenge-practice/guesses');
  expect(mocks.post.mock.calls[0][1]).toEqual({
    guess: 50,
    rulesId: NUMBER_TIMED_RULES_ID,
    roundId: 'number-v2:29862600',
    requestId: expect.any(String),
  });
  expect(mocks.get.mock.calls.every((c) => c[0] === '/games/number-challenge-practice')).toBe(true);
});
it('retries the same saved guess across remount and rejects rapid duplicates', async () => {
  mocks.post.mockRejectedValueOnce(new Error('lost response'));
  const first = mount();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Place guess' }));
  await screen.findByRole('alert');
  const entry = mocks.post.mock.calls[0][1];
  first.unmount();
  mount();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry saved guess' })).toBeEnabled()
  );
  expect(screen.getByRole('spinbutton')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved guess' }));
  expect(await screen.findByText('40 practice score')).toBeInTheDocument();
  expect(mocks.post.mock.calls[1][1]).toEqual(entry);
});
it('does not send if storage is unavailable or corrupt', async () => {
  sessionStorage.setItem(numberPendingKey('member'), 'broken');
  mount();
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeDisabled());
  expect(mocks.post).not.toHaveBeenCalled();
});
it('keeps an unconfirmed receipt when the server sends a mismatched result', async () => {
  mocks.post.mockResolvedValue({
    success: true,
    data: { receipt: { ...round, guess: 51 }, isReplay: false },
  });
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Place guess' }));
  await screen.findByRole('alert');
  expect(sessionStorage.getItem(numberPendingKey('member'))).not.toBeNull();
  expect(screen.queryByText('40 practice score')).not.toBeInTheDocument();
});
it('isolates recovery by account and allows expand/minimize and rules', async () => {
  sessionStorage.setItem(
    numberPendingKey('someone-else'),
    JSON.stringify({ requestId: 'abcdefghijklmnop', guess: 75, rulesId: NUMBER_TIMED_RULES_ID })
  );
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeEnabled());
  expect(screen.getByRole('spinbutton')).toHaveValue(50);
  fireEvent.click(screen.getByRole('button', { name: 'Expand Number Challenge view' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Minimize Number Challenge view' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('How to play & fairness')).toBeInTheDocument();
});
it('shows unavailable state and never enables a failed or unknown-rules snapshot', async () => {
  mocks.get.mockRejectedValue(new Error('disabled'));
  mount();
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Entries closed' })).toBeDisabled();
});

it('shows the shared entry countdown and hides the undrawn target', async () => {
  mount();
  await waitFor(() => expect(screen.getByLabelText('Round countdown')).toHaveTextContent('00:30'));
  expect(screen.getByText('Guesses close in')).toBeInTheDocument();
  expect(screen.queryByText('40 practice score')).not.toBeInTheDocument();
});
it('accepts one guess without revealing a target and locks the controls', async () => {
  mocks.post.mockResolvedValue({
    success: true,
    data: { receipt: { ...round, target: null, away: null, score: null }, isReplay: false },
  });
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Place guess' }));
  await screen.findByText('Guess accepted: 50');
  expect(screen.getByRole('button', { name: 'Guess placed' })).toBeDisabled();
  expect(screen.getByRole('slider')).toBeDisabled();
  expect(screen.queryByText('40 practice score')).not.toBeInTheDocument();
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it('closes new entry during the result window and displays the shared result', async () => {
  mocks.get.mockResolvedValue({ success: true, data: snapshot(31000, 52) });
  mount();
  await screen.findByText('Target: 52');
  expect(screen.getByRole('button', { name: 'Entries closed' })).toBeDisabled();
  expect(screen.getByRole('spinbutton')).toBeDisabled();
  expect(screen.getByLabelText('Round countdown')).toHaveTextContent('00:29');
  expect(mocks.post).not.toHaveBeenCalled();
});
it('reconciles saved requests even after the original round has closed', async () => {
  const entry = {
    requestId: 'abcdefghijklmnop',
    guess: 50,
    roundId: round.roundId,
    rulesId: NUMBER_TIMED_RULES_ID,
  };
  sessionStorage.setItem(numberPendingKey('member'), JSON.stringify(entry));
  mocks.get.mockResolvedValue({ success: true, data: snapshot(31000, 52) });
  mount();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry saved guess' })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved guess' }));
  await screen.findByText('40 practice score');
  expect(mocks.post.mock.calls[0][1]).toEqual(entry);
});
it('clears a definitively rejected late entry but never replaces it automatically', async () => {
  mocks.post.mockRejectedValue(
    new Error(
      JSON.stringify({ status: 409, message: 'This round is closed. Wait for the next round.' })
    )
  );
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Place guess' }));
  await screen.findByRole('alert');
  expect(sessionStorage.getItem(numberPendingKey('member'))).toBeNull();
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it('locks admission at the displayed deadline without submitting or inventing a result', async () => {
  mocks.get.mockResolvedValue({ success: true, data: snapshot(29000) });
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeEnabled());
  const now = performance.now();
  vi.spyOn(performance, 'now').mockReturnValue(now + 1500);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Entries closed' })).toBeDisabled()
  );
  expect(screen.getByRole('spinbutton')).toBeDisabled();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(screen.queryByText('Target: 52')).not.toBeInTheDocument();
});
it('locks stale snapshots and never restarts a countdown from the device wall clock', async () => {
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeEnabled());
  const now = performance.now();
  vi.spyOn(performance, 'now').mockReturnValue(now + 9000);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place guess' })).toBeDisabled());
  expect(screen.getByLabelText('Round countdown')).toHaveTextContent('—');
  expect(mocks.post).not.toHaveBeenCalled();
});

it('restores the confirmed guess in the controls and keeps its released result beside selections', async () => {
  const receipt = { ...round, guess: 25, target: 27 };
  mocks.get.mockResolvedValue({
    success: true,
    data: { ...snapshot(35000, 27), receipt, history: [receipt] },
  });
  mount();
  await screen.findByRole('heading', { name: '2 away' });
  expect(screen.getByRole('spinbutton')).toHaveValue(25);
  expect(screen.getByRole('slider')).toHaveValue('25');
  expect(screen.getByRole('button', { name: /^25$/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  const overview = screen.getByRole('region', { name: 'Number Challenge round overview' });
  expect(overview).toHaveTextContent('Target 27');
  expect(overview).toHaveTextContent('2 away · 40 practice score');
  expect(mocks.post).not.toHaveBeenCalled();
});
