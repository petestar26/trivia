import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type * as ApiModule from '@/lib/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VF_RULES_ID,
  fixtureOffer,
  parseTicketInput,
  type VfAdmission,
  type VfSnapshot,
  type VfTicketView,
} from '@socialplay/shared';
import { VirtualFootballPage } from './virtual-football';
import { buildWeek, openAt, snapshotAt } from '@/test/football-fixtures';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'fan-1' } }) }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: mocks,
}));
vi.mock('@/components/football/football-scene', () => ({
  default: (props: { reduced: boolean; label: string; fallback: unknown }) => (
    <div data-testid="scene" data-reduced={String(props.reduced)}>
      {props.label}
    </div>
  ),
}));

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

let client: QueryClient;
const WEEK = { seasonNo: 1, weekNo: 5 };
const serve = (snapshot: VfSnapshot) =>
  mocks.get.mockResolvedValue({ success: true, data: snapshot });
const admission = (
  ticket: Partial<VfTicketView> = {},
  isReplay = false
): { success: true; data: VfAdmission } => ({
  success: true,
  data: {
    accepted: true,
    isReplay,
    ticket: {
      id: 't1',
      matchweekId: 'vf-s1-w05',
      rulesId: VF_RULES_ID,
      rulesDigest: 'd',
      requestHash: 'r',
      receiptHash: 'h',
      totalStake: 10,
      totalReturn: null,
      createdAt: 0,
      settledAt: null,
      lines: [],
      ...ticket,
    },
  },
});
const wrongError = (status: number, reason?: string) =>
  new Error(
    JSON.stringify({ status, code: 'X', message: 'm', details: reason ? { reason } : undefined })
  );

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: memoryStorage(),
  });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
  Element.prototype.scrollIntoView = vi.fn();
  serve(snapshotAt());
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

async function setup() {
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <VirtualFootballPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
  await screen.findByRole('group', { name: 'Matches this week' });
}
const price = (selection: string, fixture = 0) => {
  const f = buildWeek(WEEK.seasonNo, WEEK.weekNo).fixtures[fixture];
  return fixtureOffer(f.params).byId.get(selection)!.oddsCents!;
};
const pressPrice = (name: RegExp) => fireEvent.click(screen.getAllByRole('button', { name })[0]);
const cards = () =>
  within(screen.getByRole('group', { name: 'Matches this week' })).getAllByRole('button');

describe('Virtual Football page', () => {
  it('shows ten fixtures, the first fixture’s markets and a lazy 3D scene', async () => {
    await setup();
    expect(cards()).toHaveLength(10);
    expect(screen.getByRole('heading', { level: 2, name: /Quartz|v / })).toBeInTheDocument();
    expect(await screen.findByTestId('scene')).toBeInTheDocument();
    expect(screen.getByText('Free practice')).toBeInTheDocument();
    expect(screen.getByText('No Coins · No cash prizes')).toBeInTheDocument();
    expect(screen.getAllByRole('group', { name: /selections$/ }).length).toBeGreaterThan(1);
  });

  it('prices every selection with the shared function and shows unavailable ones as not offered', async () => {
    await setup();
    const home = screen.getAllByRole('button', { name: /Full time: .* win, price/ })[0];
    expect(home.textContent).toContain(
      `${Math.floor(price('FT:1') / 100)}.${String(price('FT:1') % 100).padStart(2, '0')}`
    );
    fireEvent.click(screen.getByRole('button', { name: 'Exact' }));
    const scores = screen.getAllByRole('button', { name: /Final score/ });
    expect(scores).toHaveLength(28);
    const unavailable = scores.filter((b) => (b as HTMLButtonElement).disabled);
    for (const b of unavailable) expect(b.getAttribute('aria-label')).toMatch(/not offered/);
  });

  it('switches fixtures without losing the slip and keeps picks per fixture', async () => {
    await setup();
    pressPrice(/Full time: .* win, price/);
    const slip = screen.getByRole('complementary', { name: 'Ticket slip' });
    expect(within(slip).getAllByRole('listitem').length).toBeGreaterThan(0);
    fireEvent.click(cards()[1]);
    expect(cards()[1]).toHaveAttribute('aria-pressed', 'true');
    pressPrice(/Full time: .* win, price/);
    expect(within(slip).getByLabelText('2 selections')).toBeInTheDocument();
    expect(cards()[0].getAttribute('aria-label')).toMatch(/1 selection on your slip/);
    fireEvent.click(cards()[0]);
    const pressed = screen
      .getAllByRole('button', { pressed: true })
      .filter((b) => /Full time/.test(b.getAttribute('aria-label') ?? ''));
    expect(pressed).toHaveLength(1);
  });

  it('builds a multiple from different matches only and prices the return with the shared rules', async () => {
    await setup();
    pressPrice(/Full time: .* win, price/);
    fireEvent.click(cards()[1]);
    pressPrice(/Full time: .* win, price/);
    const slip = screen.getByRole('complementary', { name: 'Ticket slip' });
    const ticks = within(slip).getAllByRole('checkbox');
    fireEvent.click(ticks[0]);
    expect(within(slip).getByRole('button', { name: /Make a multiple of 1/ })).toBeDisabled();
    fireEvent.click(ticks[1]);
    fireEvent.click(within(slip).getByRole('button', { name: /Make a multiple of 2/ }));
    const multiple = within(slip).getByRole('region', { name: 'Multiple 1' });
    expect(within(multiple).getByText(/Combined/)).toBeInTheDocument();
    expect(within(slip).getByText('3')).toBeInTheDocument(); // lines: two singles and a multiple
  });

  it('reviews the exact ticket and posts one identical, strictly valid payload', async () => {
    mocks.post.mockResolvedValue(admission());
    await setup();
    pressPrice(/Full time: .* win, price/);
    fireEvent.click(screen.getByRole('button', { name: /Review ticket/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be changed or cancelled/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Balance after confirming/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm practice ticket' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [endpoint, body] = mocks.post.mock.calls[0];
    expect(endpoint).toBe('/games/virtual-football/tickets');
    const parsed = parseTicketInput(body);
    expect(parsed.rulesId).toBe(VF_RULES_ID);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0].legs[0].oddsCents).toBe(price('FT:1'));
    expect(parsed.idempotencyKey).toMatch(/^vf-[0-9a-f]{32}$/);
    expect(await screen.findByText(/Ticket confirmed/)).toBeInTheDocument();
    expect(localStorage.getItem('playqube.vf3d.pending.fan-1')).toBeNull();
  });

  it('keeps an unresolved receipt, retries the identical payload and recovers without a second charge', async () => {
    mocks.post
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue(admission({}, true));
    await setup();
    pressPrice(/Full time: .* win, price/);
    fireEvent.click(screen.getByRole('button', { name: /Review ticket/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Confirm practice ticket',
      })
    );
    const retry = await screen.findByRole('button', { name: 'Check this confirmation' });
    const first = mocks.post.mock.calls[0][1];
    expect(JSON.parse(localStorage.getItem('playqube.vf3d.pending.fan-1')!)).toEqual(first);
    // The slip is frozen while a receipt is unresolved: no second ticket can be started.
    expect(screen.getByRole('button', { name: /Review ticket/ })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1]).toEqual(first);
    expect(await screen.findByText(/You were not charged twice/)).toBeInTheDocument();
    expect(localStorage.getItem('playqube.vf3d.pending.fan-1')).toBeNull();
  });

  it('automatically re-checks a saved unresolved receipt once when the page reopens', async () => {
    mocks.post.mockResolvedValue(admission({}, true));
    const week = buildWeek(WEEK.seasonNo, WEEK.weekNo);
    const f = week.fixtures[0];
    localStorage.setItem(
      'playqube.vf3d.pending.fan-1',
      JSON.stringify({
        idempotencyKey: 'vf-0123456789abcdef0123456789abcdef',
        matchweekId: week.id,
        rulesId: VF_RULES_ID,
        lines: [
          {
            kind: 'SINGLE',
            stake: 10,
            legs: [{ fixtureId: f.id, selection: 'FT:1', oddsCents: price('FT:1') }],
          },
        ],
      })
    );
    await setup();
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1].idempotencyKey).toBe('vf-0123456789abcdef0123456789abcdef');
    expect(await screen.findByText(/You were not charged twice/)).toBeInTheDocument();
  });

  it('discards a damaged saved receipt instead of guessing at it', async () => {
    localStorage.setItem('playqube.vf3d.pending.fan-1', '{"idempotencyKey":"x"');
    await setup();
    expect(await screen.findByText(/could not be read, so it was discarded/)).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(localStorage.getItem('playqube.vf3d.pending.fan-1')).toBeNull();
  });

  it('says nothing was charged and clears the receipt on a definitive refusal', async () => {
    mocks.post.mockRejectedValue(wrongError(409, 'CLOSED'));
    await setup();
    pressPrice(/Full time: .* win, price/);
    fireEvent.click(screen.getByRole('button', { name: /Review ticket/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Confirm practice ticket',
      })
    );
    expect(await screen.findByText(/have closed\. Nothing was charged/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check this confirmation' })).toBeNull();
    expect(localStorage.getItem('playqube.vf3d.pending.fan-1')).toBeNull();
  });

  it('refuses stale quotes: a changed price blocks the ticket until the member accepts it', async () => {
    await setup();
    pressPrice(/Full time: .* win, price/);
    expect(screen.getByRole('button', { name: /Review ticket/ })).toBeEnabled();
    // The official offer for the fixture changes underneath the price the member was shown.
    serve(
      snapshotAt({
        mutate: (s) => {
          const f = s.current!.fixtures[0];
          const params = { ...f.params, homeAttack: f.params.homeAttack + 9 };
          s.current!.fixtures[0] = { ...f, params, offerDigest: fixtureOffer(params).digest };
        },
      })
    );
    await client.invalidateQueries();
    const alert = await screen.findByText(/price has\s+changed/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Review ticket/ })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept new prices' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Review ticket/ })).toBeEnabled()
    );
    expect(screen.queryByText(/price has\s+changed/)).toBeNull();
  });

  it('blocks admission when the rules changed under the page', async () => {
    serve(
      snapshotAt({ mutate: (s) => ((s as { rulesDigest: string }).rulesDigest = 'f'.repeat(64)) })
    );
    await setup();
    expect(await screen.findByText(/rules have been updated/i)).toBeInTheDocument();
    pressPrice(/Full time: .* win, price/);
    expect(screen.getByRole('button', { name: /Review ticket/ })).toBeDisabled();
  });

  it('refuses prices that do not verify against the public parameters', async () => {
    serve(
      snapshotAt({
        mutate: (s) => {
          s.current!.fixtures[2] = { ...s.current!.fixtures[2], offerDigest: '0'.repeat(64) };
        },
      })
    );
    await setup();
    expect(await screen.findByText(/could not be verified/)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: /Full time: .* win, price/ });
    for (const b of buttons) expect(b).toBeDisabled();
  });

  it('closes selections at kick-off using the server clock, whatever the browser says', async () => {
    const t = openAt(WEEK.seasonNo, WEEK.weekNo, 232);
    serve(snapshotAt({ serverTime: t }));
    // A browser clock that claims it is still the selection window must not matter.
    vi.spyOn(Date, 'now').mockReturnValue(openAt(WEEK.seasonNo, WEEK.weekNo, 1));
    await setup();
    expect(await screen.findByText(/Selections are closed for this matchweek/)).toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { name: /Full time: .* win, price/ }))
      expect(b).toBeDisabled();
    vi.restoreAllMocks();
  });

  it('opens selections by the server clock even when the browser clock is far behind', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    await setup();
    for (const b of screen.getAllByRole('button', { name: /Full time: .* win, price/ }))
      expect(b).toBeEnabled();
    vi.restoreAllMocks();
  });

  it('blocks a ticket larger than the balance', async () => {
    serve(snapshotAt({ balance: 5 }));
    await setup();
    pressPrice(/Full time: .* win, price/);
    expect(screen.getByRole('button', { name: /Review ticket/ })).toBeDisabled();
    expect(screen.getByText('Not enough practice credits.')).toBeInTheDocument();
  });

  it('keeps the latest completed results visible while the next matchweek is open for selections', async () => {
    await setup();
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByText('Latest completed matchweek')).toBeInTheDocument();
    expect(within(panel).getByRole('list', { name: /results$/ })).toBeInTheDocument();
    expect(within(panel).getAllByText(/FT/).length).toBeGreaterThan(5);
    // Verification runs in the browser against the revealed seed.
    fireEvent.click(within(panel).getByRole('button', { name: /Verify these results/ }));
    expect(await within(panel).findByText(/Verified: all 10 matches/)).toBeInTheDocument();
  });

  it('shows a league table of 20 clubs and the documented tie-break', async () => {
    await setup();
    fireEvent.click(screen.getByRole('tab', { name: 'League table' }));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(screen.getByText(/Ties are split by goal difference/)).toBeInTheDocument();
  });

  it('requests another matchweek by season and week and explains a week that was never played', async () => {
    await setup();
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }));
    mocks.get.mockImplementation(
      async (_endpoint: string, params?: { seasonNo?: number; weekNo?: number }) => ({
        success: true,
        data: snapshotAt({
          mutate: (s) => {
            if (params?.seasonNo)
              s.viewed = {
                seasonNo: params.seasonNo,
                weekNo: params.weekNo!,
                state: 'NOT_PLAYED',
                matchweek: null,
                opensAt: 0,
                scheduled: [{ slot: 1, homeClub: 1, awayClub: 2 }],
              };
          },
        }),
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous matchweek' }));
    expect(await screen.findByText(/This matchweek was not played/)).toBeInTheDocument();
    expect(mocks.get).toHaveBeenLastCalledWith(
      '/games/virtual-football',
      { seasonNo: 1, weekNo: 3 },
      expect.anything()
    );
  });

  it('counts the 3D scene as optional: the text match centre is a complete alternative', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Text match centre' }));
    expect(screen.queryByTestId('scene')).toBeNull();
    expect(screen.getByRole('region', { name: 'Match centre' })).toBeInTheDocument();
    expect(screen.getByText('Kick-off soon')).toBeInTheDocument();
  });

  it('passes reduced motion to the scene, from the page control', async () => {
    await setup();
    expect((await screen.findByTestId('scene')).getAttribute('data-reduced')).toBe('false');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reduced motion' }));
    expect(screen.getByTestId('scene').getAttribute('data-reduced')).toBe('true');
  });

  it('uses numeric inputs sized for phone keyboards and keeps a tray that scrolls to the slip', async () => {
    await setup();
    pressPrice(/Full time: .* win, price/);
    const stake = screen.getByRole('spinbutton', { name: /Single 1 stake/ });
    expect(stake).toHaveAttribute('inputmode', 'numeric');
    expect(stake).toHaveAttribute('min', '5');
    expect(stake).toHaveAttribute('max', '500');
    fireEvent.click(screen.getByRole('button', { name: /Ticket · 1 selection/ }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('shows the rules, including the practice-only and no-cash-out promises', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: /How it works/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Confirmed tickets cannot be changed, cancelled or cashed out/)
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/cannot be bought, transferred or\s+redeemed/)
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/European handicap: home \(-1\)/)).toBeInTheDocument();
  });

  it('shows the last played matchweek and counts down to the next, never inventing a missed one', async () => {
    serve(snapshotAt({ created: false, serverTime: openAt(WEEK.seasonNo, WEEK.weekNo, 240) }));
    await setup();
    expect(await screen.findByText(/Last played matchweek/)).toBeInTheDocument();
    expect(screen.getByText(/next opens in/)).toBeInTheDocument();
    // Nothing can be selected in a matchweek that was never created.
    for (const b of screen.getAllByRole('button', { name: /Full time: .* win, price/ }))
      expect(b).toBeDisabled();
  });

  it('waits with a countdown when there is nothing at all to show yet', async () => {
    serve(
      snapshotAt({
        created: false,
        serverTime: openAt(WEEK.seasonNo, WEEK.weekNo, 240),
        mutate: (s) => (s.latestCompleted = null),
      })
    );
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <VirtualFootballPage />
        </QueryClientProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText(/The next matchweek opens in/)).toBeInTheDocument();
  });
});
