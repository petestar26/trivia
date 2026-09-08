import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const searchUsers = vi.fn();
const createChallenge = vi.fn();
const getUserChallenges = vi.fn();
const acceptChallenge = vi.fn();
const declineChallenge = vi.fn();
const cancelChallenge = vi.fn();
const toastMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    searchUsers: (...a: unknown[]) => searchUsers(...a),
    createChallenge: (...a: unknown[]) => createChallenge(...a),
    getUserChallenges: (...a: unknown[]) => getUserChallenges(...a),
    acceptChallenge: (...a: unknown[]) => acceptChallenge(...a),
    declineChallenge: (...a: unknown[]) => declineChallenge(...a),
    cancelChallenge: (...a: unknown[]) => cancelChallenge(...a),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: (...a: unknown[]) => toastMock(...a) }) }));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'me-uuid', username: 'me', displayName: 'Me' } }),
}));

import { ChallengesPage } from './challenges';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  searchUsers.mockReset();
  createChallenge.mockReset();
  getUserChallenges.mockReset();
  acceptChallenge.mockReset();
  declineChallenge.mockReset();
  cancelChallenge.mockReset();
  toastMock.mockReset();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<ChallengesPage />, { wrapper });
}

/**
 * Renders the page and waits (on REAL timers) for the initial challenge-list
 * query to settle and the form to appear, THEN switches to fake timers.
 *
 * Sequencing this matters: `useQuery`'s promise resolution takes a few
 * microtask hops before `isLoading` flips false and the form (including the
 * "Game" field used by several tests) mounts. `screen.findByText` polls
 * reliably here because real timers are still active; only once the form is
 * confirmed present do we switch to fake timers to take deterministic
 * control of the search debounce.
 */
async function renderReady() {
  renderPage();
  await screen.findByText('Challenge a Friend');
  vi.useFakeTimers();
}

/** Fires the debounce timer and drains the microtask queue for any chained
 * mutation → onSuccess/onError → setState work, without relying on
 * `waitFor` (whose retry loop uses real timers and cannot advance while
 * fake timers are active). */
async function advanceAndFlush(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  // vi's fake timers (sinon-based) do not fake the microtask queue, so a
  // couple of bare async `act` passes are enough to drain a short promise
  // chain (mutate → mutationFn → onSuccess → setState → re-render).
  await act(async () => {});
  await act(async () => {});
}

const USER_PETE = { id: 'user-pete-uuid', username: 'petestar26', displayName: 'Peter', avatarUrl: null };
const USER_ALT = { id: 'user-alt-uuid', username: 'alt_user', displayName: null, avatarUrl: null };

function stubEmptyChallengeList() {
  getUserChallenges.mockResolvedValue({ success: true, data: [] });
}

function getSearchInput() {
  return screen.getByLabelText('Search by username or email');
}

function fillGameAndAmount() {
  fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
  fireEvent.change(screen.getByLabelText('Entry Amount (GP)'), { target: { value: '10' } });
}

// ═══════════════════════════════════════════════════════════════
// INITIAL
// ═══════════════════════════════════════════════════════════════

describe('ChallengesPage — initial render', () => {
  it('the raw UUID input no longer exists', async () => {
    stubEmptyChallengeList();
    renderPage();
    await screen.findByText('Challenge a Friend');

    expect(screen.queryByPlaceholderText('paste-their-uuid-here')).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Friend's User ID")).not.toBeInTheDocument();
  });

  it('shows the new search label', async () => {
    stubEmptyChallengeList();
    renderPage();
    await screen.findByText('Challenge a Friend');

    expect(screen.getByLabelText('Search by username or email')).toBeInTheDocument();
  });

  it('submit is disabled without a selected recipient', async () => {
    stubEmptyChallengeList();
    renderPage();
    await screen.findByText('Challenge a Friend');

    expect(screen.getByRole('button', { name: 'Send Challenge' })).toBeDisabled();
  });
});

// ═══════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════

describe('ChallengesPage — search', () => {
  it('"ab" (below minimum username length) triggers no request', async () => {
    stubEmptyChallengeList();
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'ab' } });
    await advanceAndFlush(300);

    expect(searchUsers).not.toHaveBeenCalled();
  });

  it('a valid 3-char username triggers exactly one debounced request', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [] });
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'abc' } });
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(searchUsers).not.toHaveBeenCalled();

    await advanceAndFlush(1);
    expect(searchUsers).toHaveBeenCalledTimes(1);
    expect(searchUsers).toHaveBeenCalledWith('abc');
  });

  it('rapid typing does not issue a request per keystroke', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [] });
    await renderReady();

    const input = getSearchInput();
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });
    await advanceAndFlush(300);

    expect(searchUsers).toHaveBeenCalledTimes(1);
    expect(searchUsers).toHaveBeenCalledWith('abc');
  });

  it('a valid email triggers a debounced search', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [] });
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'someone@example.com' } });
    await advanceAndFlush(300);

    expect(searchUsers).toHaveBeenCalledWith('someone@example.com');
  });

  it('shows "Searching…" while the request is pending', async () => {
    stubEmptyChallengeList();
    let resolveFn: ((v: unknown) => void) | undefined;
    searchUsers.mockImplementation(() => new Promise((r) => { resolveFn = r; }));
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);

    expect(screen.getByText('Searching…')).toBeInTheDocument();

    await act(async () => {
      resolveFn!({ success: true, data: [] });
    });
    await act(async () => {});
  });

  it('renders search results', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_PETE] });
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);

    expect(screen.getByText('Peter')).toBeInTheDocument();
    expect(screen.getByText('@petestar26')).toBeInTheDocument();
  });

  it('shows "No matching user found." for an empty result set', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [] });
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'nobodyhere' } });
    await advanceAndFlush(300);

    expect(screen.getByText('No matching user found.')).toBeInTheDocument();
  });

  it('shows a friendly rate-limit message on 429 and does not retry automatically', async () => {
    stubEmptyChallengeList();
    searchUsers.mockRejectedValue(
      new Error(JSON.stringify({ status: 429, code: 'RATE_LIMITED', message: 'Too many requests' })),
    );
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);

    expect(screen.getByText('Too many searches. Try again shortly.')).toBeInTheDocument();

    const callsAfterFirst = searchUsers.mock.calls.length;
    // No automatic retry: advancing time further with no new input issues no
    // additional call.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await act(async () => {});
    expect(searchUsers.mock.calls.length).toBe(callsAfterFirst);
  });

  it('shows a generic failure message for a non-429 error', async () => {
    stubEmptyChallengeList();
    searchUsers.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);

    expect(screen.getByText('Unable to search right now.')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════
// PRIVACY
// ═══════════════════════════════════════════════════════════════

describe('ChallengesPage — privacy', () => {
  it('renders only avatar/displayName/@username — never the id, and never echoes the searched email', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_PETE] });
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'petestar26@example.com' } });
    await advanceAndFlush(300);

    expect(screen.getByText('Peter')).toBeInTheDocument();
    expect(screen.getByText('@petestar26')).toBeInTheDocument();
    expect(screen.queryByText('user-pete-uuid')).not.toBeInTheDocument();
    expect(screen.queryByText('petestar26@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText(/example\.com/)).not.toBeInTheDocument();
  });

  it('renders "@username" alone when displayName is null', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_ALT] });
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'alt_user' } });
    await advanceAndFlush(300);

    expect(screen.getByText('@alt_user')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════
// SELECTION
// ═══════════════════════════════════════════════════════════════

describe('ChallengesPage — selection', () => {
  it('clicking a result selects it and shows the selected-recipient card', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_PETE] });
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);

    fireEvent.click(screen.getByRole('button', { name: /Peter/ }));
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Remove selected recipient' })).toBeInTheDocument();
    // Dropdown collapses.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('editing the search input after a selection clears it immediately and re-disables submit', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_PETE] });
    await renderReady();

    fillGameAndAmount();
    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);
    fireEvent.click(screen.getByRole('button', { name: /Peter/ }));
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Send Challenge' })).not.toBeDisabled();

    fireEvent.change(getSearchInput(), { target: { value: 'petestar26x' } });
    await act(async () => {});

    expect(screen.queryByRole('button', { name: 'Remove selected recipient' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send Challenge' })).toBeDisabled();
  });

  it('Remove clears the selection and restores the existing results without a second request', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_PETE] });
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);
    fireEvent.click(screen.getByRole('button', { name: /Peter/ }));
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Remove selected recipient' }));
    await act(async () => {});

    // Selection is gone and submit is disabled.
    expect(screen.queryByRole('button', { name: 'Remove selected recipient' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send Challenge' })).toBeDisabled();

    // The picker must NOT go inert: the search text and the previously
    // fetched result list are both still there, immediately, with no
    // spinner/empty-state/error in their place.
    expect((getSearchInput() as HTMLInputElement).value).toBe('petestar26');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const resultButton = screen.getByRole('button', { name: /Peter/ });
    expect(resultButton).toBeInTheDocument();
    expect(screen.queryByText('Searching…')).not.toBeInTheDocument();
    expect(screen.queryByText('No matching user found.')).not.toBeInTheDocument();

    // The restored result must be reselectable.
    fireEvent.click(resultButton);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Remove selected recipient' })).toBeInTheDocument();

    // Exactly one network call total: Remove, and reselecting from the
    // restored list, must not trigger a redundant search.
    expect(searchUsers).toHaveBeenCalledTimes(1);
  });

  it('editing to a query that trims back to the same debounced value does not leave the picker inert', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_PETE] });
    await renderReady();

    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);
    fireEvent.click(screen.getByRole('button', { name: /Peter/ }));
    await act(async () => {});

    // Trailing whitespace trims to the exact same debounced query as before.
    fireEvent.change(getSearchInput(), { target: { value: 'petestar26 ' } });
    await advanceAndFlush(300);

    // Selection cleared, but the still-current result list is visible again
    // rather than the picker going blank.
    expect(screen.queryByRole('button', { name: 'Remove selected recipient' })).not.toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Peter/ })).toBeInTheDocument();
    expect(searchUsers).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// SUBMIT
// ═══════════════════════════════════════════════════════════════

describe('ChallengesPage — submission safety', () => {
  it('typed username/email alone, without a selection, cannot call createChallenge', async () => {
    stubEmptyChallengeList();
    await renderReady();

    fillGameAndAmount();
    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    // Deliberately do not select a result.
    fireEvent.click(screen.getByRole('button', { name: 'Send Challenge' }));
    await act(async () => {});

    expect(createChallenge).not.toHaveBeenCalled();
  });

  it('after selecting a result, submitting calls createChallenge exactly once with the selected id', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_PETE] });
    createChallenge.mockResolvedValue({ success: true, data: { id: 'chal-1' } });
    await renderReady();

    fillGameAndAmount();
    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);
    fireEvent.click(screen.getByRole('button', { name: /Peter/ }));
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Send Challenge' }));
    await act(async () => {});
    await act(async () => {});

    expect(createChallenge).toHaveBeenCalledTimes(1);
    expect(createChallenge).toHaveBeenCalledWith({
      challengedId: 'user-pete-uuid',
      gameKey: 'dice',
      entryAmount: 10,
    });
    // The typed search text is never what gets submitted.
    expect(createChallenge.mock.calls[0][0].challengedId).not.toBe('petestar26');
  });
});

// ═══════════════════════════════════════════════════════════════
// STALE RESPONSE
// ═══════════════════════════════════════════════════════════════

describe('ChallengesPage — stale response protection', () => {
  it('an older response cannot overwrite a newer query\'s results', async () => {
    stubEmptyChallengeList();
    let resolveA: ((v: unknown) => void) | undefined;
    let resolveB: ((v: unknown) => void) | undefined;
    const pA = new Promise((r) => { resolveA = r; });
    const pB = new Promise((r) => { resolveB = r; });
    searchUsers.mockImplementationOnce(() => pA).mockImplementationOnce(() => pB);

    await renderReady();

    // Request A: fired first.
    fireEvent.change(getSearchInput(), { target: { value: 'pete_user' } });
    await advanceAndFlush(300);
    expect(searchUsers).toHaveBeenCalledTimes(1);

    // Request B: newer query, fired before A resolves.
    fireEvent.change(getSearchInput(), { target: { value: 'alt_user' } });
    await advanceAndFlush(300);
    expect(searchUsers).toHaveBeenCalledTimes(2);

    // B resolves first.
    await act(async () => {
      resolveB!({ success: true, data: [USER_ALT] });
    });
    await act(async () => {});
    expect(screen.getByText('@alt_user')).toBeInTheDocument();

    // A resolves late — must NOT overwrite B's rendered results.
    await act(async () => {
      resolveA!({ success: true, data: [USER_PETE] });
    });
    await act(async () => {});

    expect(screen.getByText('@alt_user')).toBeInTheDocument();
    expect(screen.queryByText('@petestar26')).not.toBeInTheDocument();
    expect(screen.queryByText('Peter')).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════
// ERROR
// ═══════════════════════════════════════════════════════════════

describe('ChallengesPage — challenge creation error handling', () => {
  it('does not render raw JSON for a 404 "Challenged user not found" and shows friendly copy', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_PETE] });
    createChallenge.mockRejectedValue(
      new Error(JSON.stringify({ status: 404, code: 'NOT_FOUND', message: 'Challenged user not found' })),
    );
    await renderReady();

    fillGameAndAmount();
    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);
    fireEvent.click(screen.getByRole('button', { name: /Peter/ }));
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Send Challenge' }));
    await act(async () => {});
    await act(async () => {});

    expect(screen.getByText('This user is no longer available to challenge.')).toBeInTheDocument();
    expect(screen.queryByText(/NOT_FOUND/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"status"/)).not.toBeInTheDocument();

    // Selection is preserved so the user can Remove/retry intentionally.
    expect(screen.getByRole('button', { name: 'Remove selected recipient' })).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════
// REGRESSION
// ═══════════════════════════════════════════════════════════════

describe('ChallengesPage — regression', () => {
  it('game and entry-amount fields remain, and a successful challenge refreshes challenges + wallet', async () => {
    stubEmptyChallengeList();
    searchUsers.mockResolvedValue({ success: true, data: [USER_PETE] });
    createChallenge.mockResolvedValue({ success: true, data: { id: 'chal-1' } });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    render(<ChallengesPage />, { wrapper });
    await screen.findByText('Challenge a Friend');
    vi.useFakeTimers();

    expect(screen.getByLabelText('Game')).toBeInTheDocument();
    expect(screen.getByLabelText('Entry Amount (GP)')).toBeInTheDocument();

    fillGameAndAmount();
    fireEvent.change(getSearchInput(), { target: { value: 'petestar26' } });
    await advanceAndFlush(300);
    fireEvent.click(screen.getByRole('button', { name: /Peter/ }));
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Send Challenge' }));
    await act(async () => {});
    await act(async () => {});

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['challenges'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(toastMock).toHaveBeenCalledWith({ title: 'Challenge sent', description: 'Your challenge has been sent.' });
  });

  it('still renders the existing challenge list', async () => {
    getUserChallenges.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'chal-1',
          gameName: 'Dice',
          gameKey: 'dice',
          challenger: { id: 'me-uuid', username: 'me', displayName: 'Me' },
          challenged: { id: 'other-uuid', username: 'other', displayName: 'Other' },
          entryAmount: 0,
          status: 'PENDING',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      ],
    });
    renderPage();

    expect(await screen.findByText('Dice')).toBeInTheDocument();
    expect(screen.getByText(/You challenged Other/)).toBeInTheDocument();
  });
});
