import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const getWallet = vi.fn();
const getWalletTransactions = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    getWallet: (...a: unknown[]) => getWallet(...a),
    getWalletTransactions: (...a: unknown[]) => getWalletTransactions(...a),
  },
}));

import { WalletPage } from './wallet';

afterEach(() => {
  cleanup();
  getWallet.mockReset();
  getWalletTransactions.mockReset();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<WalletPage />, { wrapper });
}

/**
 * Realistic ledger rows mirroring the actual `GET /wallet/transactions`
 * contract: `amount` is a positive magnitude for BOTH directions (the writer
 * stores CREDIT/DEBIT in `ledgerType`, which the API does NOT return), and
 * direction is derivable only from `balanceAfter - balanceBefore`. `type` /
 * `currency` / `referenceType` use real Prisma enum values.
 */
const GP_CREDIT = {
  id: 'tx-gp-credit',
  type: 'GAME_POINT_CREDIT',
  currency: 'GAME_POINTS',
  amount: 5,
  balanceBefore: 0,
  balanceAfter: 5,
  referenceType: 'REWARD',
  referenceId: 'reward-1',
  description: 'Daily login award',
  createdAt: '2026-01-01T12:00:00.000Z',
};

const COIN_DEBIT = {
  id: 'tx-coin-debit',
  type: 'COIN_DEBIT',
  currency: 'COINS',
  amount: 100,
  balanceBefore: 200,
  balanceAfter: 100,
  referenceType: 'GAME',
  referenceId: null,
  description: 'Game entry fee',
  createdAt: '2026-01-02T15:30:00.000Z',
};

describe('WalletPage — balance cards', () => {
  it('renders Coins and Game Points balances from the API response', async () => {
    getWallet.mockResolvedValue({ success: true, data: { coinsBalance: 120, gamePointsBalance: 75 } });
    getWalletTransactions.mockResolvedValue({ success: true, data: [], meta: { page: 1, total: 0, totalPages: 0 } });

    renderPage();

    // Both balances appear on screen.
    expect(await screen.findByText('120')).toBeInTheDocument();
    expect(screen.getByText('75')).toBeInTheDocument();
  });
});

// Regression: `api.getWalletTransactions()` returns ApiResponse, so `.data`
// in the queryFn already yields the array. The page then accessed `.data`
// again on that array — always producing `undefined` — so transaction
// history rendered as "No transactions yet." regardless of server payload.
describe('WalletPage — transaction history', () => {
  it('renders transaction rows returned by the API instead of the empty state', async () => {
    getWallet.mockResolvedValue({ success: true, data: { coinsBalance: 0, gamePointsBalance: 0 } });
    getWalletTransactions.mockResolvedValue({
      success: true,
      data: [GP_CREDIT, COIN_DEBIT],
      meta: { page: 1, total: 2, totalPages: 1 },
    });

    renderPage();

    // Real enum labels are shown verbatim.
    expect(await screen.findByText('GAME_POINT_CREDIT')).toBeInTheDocument();
    expect(screen.getByText('GAME_POINTS')).toBeInTheDocument();
    expect(screen.getByText('COIN_DEBIT')).toBeInTheDocument();
    expect(screen.getByText('COINS')).toBeInTheDocument();
    expect(screen.queryByText('No transactions yet.')).not.toBeInTheDocument();
  });

  it('renders a GP credit as a positive, credit-styled amount', async () => {
    getWallet.mockResolvedValue({ success: true, data: { coinsBalance: 0, gamePointsBalance: 0 } });
    getWalletTransactions.mockResolvedValue({
      success: true,
      data: [GP_CREDIT],
      meta: { page: 1, total: 1, totalPages: 1 },
    });

    renderPage();

    const amount = await screen.findByText('+5');
    // balanceAfter (5) > balanceBefore (0) => credit presentation.
    expect(amount).toHaveClass('text-green-600 dark:text-green-400');
  });

  it('renders a Coin debit as a negative, debit-styled amount', async () => {
    getWallet.mockResolvedValue({ success: true, data: { coinsBalance: 0, gamePointsBalance: 0 } });
    getWalletTransactions.mockResolvedValue({
      success: true,
      data: [COIN_DEBIT],
      meta: { page: 1, total: 1, totalPages: 1 },
    });

    renderPage();

    const amount = await screen.findByText('−100');
    // balanceAfter (100) < balanceBefore (200) => debit presentation.
    expect(amount).toHaveClass('text-red-600 dark:text-red-400');
  });

  it('shows the empty state when the API legitimately returns no transactions', async () => {
    getWallet.mockResolvedValue({ success: true, data: { coinsBalance: 50, gamePointsBalance: 30 } });
    getWalletTransactions.mockResolvedValue({
      success: true,
      data: [],
      meta: { page: 1, total: 0, totalPages: 0 },
    });

    renderPage();

    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
  });

  it('shows a distinct error state when the transaction API call fails', async () => {
    getWallet.mockResolvedValue({ success: true, data: { coinsBalance: 0, gamePointsBalance: 0 } });
    getWalletTransactions.mockRejectedValue(new Error('Network error'));

    renderPage();

    expect(await screen.findByText(/Failed to load wallet/)).toBeInTheDocument();
    expect(screen.queryByText('No transactions yet.')).not.toBeInTheDocument();
  });
});