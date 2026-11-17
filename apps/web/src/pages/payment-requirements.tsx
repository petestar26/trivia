import { Link } from 'react-router-dom';
import { ETB_P2P_REQUIREMENTS } from '@socialplay/shared';
import { useLanguage } from '@/providers/language-provider';

/** Operational requirements, not legal terms or a claim of provider support. */
export function PaymentRequirementsPage() {
  const { t } = useLanguage();
  return <section className="payment-page">
    <h1>{t('Payment requirements')}</h1>
    <p>{t('These limits apply to new ETB agent payment requests. Existing orders and accepted quotes keep their recorded terms.')}</p>
    <dl>
      <dt>{t('Deposit')}</dt><dd>{ETB_P2P_REQUIREMENTS.depositMinMinor / 100} ETB</dd>
      <dt>{t('Withdrawal')}</dt><dd>{ETB_P2P_REQUIREMENTS.withdrawalMinMinor / 100} ETB</dd>
    </dl>
    <p>{t('The minimum amount is included. Agent limits, available eligible balance, account verification and payment availability still apply.')}</p>
    <p>{t('Crypto uses its own quoted requirements. Check that payment flow before sending funds.')}</p>
    <p>{t('Casino stakes are separate from payment minimums. Provider, game, balance and responsible-gambling restrictions still apply.')}</p>
    <p><Link to="/wallet/deposit">{t('Deposit')}</Link> · <Link to="/wallet/withdraw">{t('Withdrawal')}</Link> · <Link to="/support">{t('Support')}</Link></p>
  </section>;
}
