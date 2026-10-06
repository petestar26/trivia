import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@/lib/api';
import contract from '@/test/fixtures/game-history.contract.json';

// The API side (apps/api/src/games/history-contract.test.ts) proves the real
// /games/history route answers exactly this fixture's shape.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(async (path: string) => {
        if (path === '/games/history') return contract;
        throw new Error(`Unexpected GET ${path}`);
      }),
    },
  };
});

import { GameHistoryPage } from './history';

afterEach(cleanup);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><GameHistoryPage /></QueryClientProvider>);
}

const row = (id: string) => screen.findByTestId(`history-row-${id}`);

describe('GameHistoryPage against the API history contract', () => {
  it('renders a competition round as such, with no stake and no Coins debit', async () => {
    renderPage();
    const competition = await row('session-competition-round');
    expect(within(competition).getByText('Competition round')).toBeInTheDocument();
    expect(competition.textContent).not.toMatch(/Bet:|−|Coins/);
  });

  it('renders a challenge round as such, with no stake and no Coins debit', async () => {
    renderPage();
    const challenge = await row('session-challenge-round');
    expect(within(challenge).getByText('Challenge round')).toBeInTheDocument();
    expect(challenge.textContent).not.toMatch(/Bet:|−|Coins/);
  });

  it('shows no debit anywhere for contest rounds: every debit shown is a real solo wager', async () => {
    renderPage();
    await row('session-solo-loss');
    const debits = screen.getAllByText(/^−\d+/);
    expect(debits).toHaveLength(1);
    expect(within(await row('session-solo-loss')).getByText('−50 Coins')).toBeInTheDocument();
  });

  it('still shows a solo wager and a solo win with their real settlement currencies', async () => {
    renderPage();
    const loss = await row('session-solo-loss');
    expect(within(loss).getByText(/Bet:/)).toHaveTextContent('Bet: 50 Coins');
    const win = await row('session-solo-win');
    expect(within(win).getByText('+120 Coins')).toBeInTheDocument();
    expect(within(win).getByText(/Bet:/)).toHaveTextContent('Bet: 40 Coins');
  });

  it('shows a bonus reward without inventing a stake', async () => {
    renderPage();
    const bonus = await row('session-bonus-win');
    expect(within(bonus).getByText('+30 Coins')).toBeInTheDocument();
    expect(bonus.textContent).not.toMatch(/Bet:|−/);
  });

  it('shows the result schema and rules versions it receives', async () => {
    renderPage();
    const competition = await row('session-competition-round');
    expect(competition.textContent).toContain('Rules v1');
    expect(competition.textContent).toContain('Schema v1');
  });
});
