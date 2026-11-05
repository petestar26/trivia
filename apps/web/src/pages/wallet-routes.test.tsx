import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/practice-etb', () => ({ PRACTICE_ETB: true }));
vi.mock('./practice-wallet', () => ({
  PracticeWalletPage: () => <h1>Payment and practice balances</h1>,
}));
vi.mock('./wallet', () => ({ WalletPage: () => <h1>Legacy wallet</h1> }));
vi.mock('./wallet-agent-setup', () => ({
  WalletAgentSetupPage: () => <h1>Agent account setup</h1>,
}));
vi.mock('./wallet-payments', () => ({
  WalletPaymentsPage: () => {
    const { section } = useParams();
    return <h1>Agent {section}</h1>;
  },
}));
vi.mock('./crypto-payments', () => ({
  CryptoPaymentsPage: () => {
    const [search] = useSearchParams();
    return <h1>Crypto {search.get('direction')}</h1>;
  },
}));
import { WalletRoutes } from './wallet-routes';
afterEach(cleanup);
it.each([
  ['/wallet', 'Payment and practice balances'],
  ['/wallet/deposit', 'Agent deposit'],
  ['/wallet/withdraw', 'Agent withdraw'],
  ['/wallet/activity', 'Agent activity'],
  ['/wallet/agent-setup', 'Agent account setup'],
  ['/wallet/crypto?direction=deposit', 'Crypto deposit'],
  ['/wallet/crypto?direction=withdraw', 'Crypto withdraw'],
])('keeps %s accessible with practice games enabled', (url, title) => {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="wallet/*" element={<WalletRoutes />} />
      </Routes>
    </MemoryRouter>
  );
  expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
});
