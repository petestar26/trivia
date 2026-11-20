import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => ({data: {
  available: true, localPerUsd: '150', observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now()+60000).toISOString(), p2pDepositMinUsdCents: 200,
  p2pWithdrawalAboveUsdCents: 400, cryptoDepositMinUsdCents: 1000,
  cryptoWithdrawalAboveUsdCents: 2000,
}})) }, unwrapData: (r: {data: unknown}) => r.data }));
import { WalletPricingAdmin } from './wallet-pricing-admin';
it('shows fixed inclusive agent minimums separately from unchanged crypto reference', async () => {
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><WalletPricingAdmin /></QueryClientProvider>);
  expect(await screen.findByText('Minimum P2P deposit is 100 ETB')).toBeInTheDocument();
  expect(screen.getByText('Minimum P2P withdrawal is 500 ETB')).toBeInTheDocument();
  expect(screen.getByText('10.00 USDT')).toBeInTheDocument();
  expect(screen.queryByText('USD 2.00 equivalent in ETB')).not.toBeInTheDocument();
});
