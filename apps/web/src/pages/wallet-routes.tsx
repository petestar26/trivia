import { Route, Routes } from 'react-router-dom';
import { PRACTICE_ETB } from '@/lib/practice-etb';
import { PracticeWalletPage } from './practice-wallet';
import { WalletPage } from './wallet';
import { WalletPaymentsPage } from './wallet-payments';
import { WalletAgentSetupPage } from './wallet-agent-setup';
import { CryptoPaymentsPage } from './crypto-payments';

// Practice affects game/gift balances, not access to payment forms. The API
// remains authoritative for payment availability, eligibility and settlement.
export function WalletRoutes() {
  return (
    <Routes>
      <Route index element={PRACTICE_ETB ? <PracticeWalletPage /> : <WalletPage />} />
      <Route path="agent-setup" element={<WalletAgentSetupPage />} />
      <Route path="crypto" element={<CryptoPaymentsPage />} />
      <Route path=":section" element={<WalletPaymentsPage />} />
    </Routes>
  );
}
