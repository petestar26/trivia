import { Link, useLocation } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Coins, UserRound } from 'lucide-react';
import './wallet-navigation.css';

export type PaymentDirection = 'deposit' | 'withdraw';
export function paymentPath(direction: PaymentDirection, method: 'agent' | 'crypto') {
  return method === 'crypto' ? `/wallet/crypto?direction=${direction}` : `/wallet/${direction}`;
}

export function PaymentNavigation({ method = 'agent' }: { method?: 'agent' | 'crypto' }) {
  const { pathname, search } = useLocation();
  const direction =
    new URLSearchParams(search).get('direction') === 'withdraw' ? 'withdraw' : 'deposit';
  const active = pathname === '/wallet/crypto' ? direction : pathname.split('/').at(-1);
  return (
    <nav aria-label="Wallet sections" className="wallet-navigation">
      {[
        ['/wallet', 'Overview', 'wallet'],
        [paymentPath('deposit', method), 'Deposit', 'deposit'],
        [paymentPath('withdraw', method), 'Withdraw', 'withdraw'],
        ['/wallet/activity', 'Activity', 'activity'],
      ].map(([to, label, key]) => (
        <Link key={key} to={to} aria-current={active === key ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function WalletQuickActions() {
  return (
    <div className="wallet-quick-actions">
      <Link to="/wallet/deposit">
        <ArrowDownLeft aria-hidden="true" size={20} />
        Deposit
      </Link>
      <Link to="/wallet/withdraw">
        <ArrowUpRight aria-hidden="true" size={20} />
        Withdraw
      </Link>
    </div>
  );
}

export function PaymentMethodChooser({
  direction,
  method,
}: {
  direction: PaymentDirection;
  method: 'agent' | 'crypto';
}) {
  return (
    <section className="wallet-method-picker" aria-label="Payment method options">
      <h2>Choose how to {direction === 'deposit' ? 'deposit' : 'withdraw'}</h2>
      <div className="wallet-method-options">
        <Link
          to={paymentPath(direction, 'agent')}
          aria-current={method === 'agent' ? 'page' : undefined}
        >
          <UserRound size={24} aria-hidden="true" />
          <span>
            <strong>Agent</strong>
            <small>Bank or mobile money</small>
          </span>
          <b aria-hidden="true">{method === 'agent' ? '✓' : '→'}</b>
        </Link>
        <Link
          to={paymentPath(direction, 'crypto')}
          aria-current={method === 'crypto' ? 'page' : undefined}
        >
          <Coins size={24} aria-hidden="true" />
          <span>
            <strong>Crypto</strong>
            <small>USDT · TRON (TRC20)</small>
          </span>
          <b aria-hidden="true">{method === 'crypto' ? '✓' : '→'}</b>
        </Link>
      </div>
    </section>
  );
}

export function PaymentSteps({
  direction,
  method,
}: {
  direction: PaymentDirection;
  method: 'agent' | 'crypto';
}) {
  const steps =
    method === 'agent'
      ? direction === 'deposit'
        ? ['Choose amount & agent', 'Pay using order details', 'Agent confirms your deposit']
        : ['Choose amount & account', 'Review and confirm', 'Agent sends your payout']
      : direction === 'deposit'
        ? ['Enter USDT amount', 'Send to your unique address', 'Track transfer confirmation']
        : ['Enter amount & address', 'Review and confirm', 'Track your USDT payout'];
  return (
    <ol className="wallet-payment-steps" aria-label="How it works">
      {steps.map((step, i) => (
        <li key={step}>
          <span>{i + 1}</span>
          {step}
        </li>
      ))}
    </ol>
  );
}
