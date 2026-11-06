import { useQuery } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

type Reference = {
  available: boolean;
  localPerUsd?: string;
  observedAt?: string;
  expiresAt?: string;
  reason?: string;
  p2pDepositMinUsdCents?: number;
  p2pWithdrawalAboveUsdCents?: number;
  cryptoDepositMinUsdCents?: number;
  cryptoWithdrawalAboveUsdCents?: number;
};

export function WalletPricingAdmin() {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const rate = useQuery({
    queryKey: ['payments', 'etb-reference'],
    queryFn: async () => unwrapData(await api.get<Reference>('/wallet/exchange-rate')),
    refetchInterval: 30_000,
  });
  const fresh = rate.data?.available && Date.parse(rate.data.expiresAt ?? '') > Date.now();
  return (
    <section className="payment-panel">
      <h1>{translateUi('Birr wallet & exchange rate')}</h1>
      <p>
        {translateUi(
          'Members hold one balance in ETB. Agent deposits credit Birr directly. Crypto deposits convert USDT to ETB using the rate shown before confirmation.'
        )}
      </p>
      <div className="payment-disclosure">
        <strong>{translateUi('Wallet currency: Birr (ETB)')}</strong>
        <p>{translateUi('Precision: 0.01 ETB · Platform conversion fee: 0')}</p>
        {rate.isPending ? (
          <p role="status">{translateUi('Loading the exchange rate…')}</p>
        ) : fresh ? (
          <>
            <h2>
              {translateUi('1 USD = {localPerUsd} ETB', {
                localPerUsd: rate.data!.localPerUsd ?? '',
              })}
            </h2>
            <p>
              {translateUi('Observed {value}', {
                value: new Date(rate.data!.observedAt!).toLocaleString(interfaceLocale),
              })}
            </p>
            <p>
              {translateUi('New quotes available until {value}', {
                value: new Date(rate.data!.expiresAt!).toLocaleString(interfaceLocale),
              })}
            </p>
          </>
        ) : (
          <p role="status">
            {rate.data?.reason ??
              translateUi(
                'A fresh exchange rate is unavailable. New conversion quotes are paused.'
              )}
          </p>
        )}
        <p>
          {translateUi('Source:')}{' '}
          <a href="https://ethioblackmarket.com/" target="_blank" rel="noreferrer">
            {'EthioBlackMarket'}
          </a>
          {translateUi(
            '. The server checks every 15 minutes. Rates expire 30 minutes after the source observation.'
          )}
        </p>
        <button disabled={rate.isFetching} onClick={() => void rate.refetch()}>
          {translateUi('Refresh status')}
        </button>
      </div>
      <h2>{translateUi('How payments are priced')}</h2>
      <p>
        {translateUi(
          'USDT is quoted at 1 USDT = USD 1 using the displayed USD reference. This reference is not a guaranteed exchange execution price. The exact ETB amount is locked when the payment request is created.'
        )}
      </p>
      <p>
        {translateUi(
          'Verified deposits credit the saved ETB amount. Later rate changes never revalue wallet balances. Withdrawals reserve the requested ETB amount and show the USDT payout before confirmation.'
        )}
      </p>
      {fresh && (
        <dl>
          <dt>{translateUi('Agent deposit minimum')}</dt>
          <dd>
            {translateUi('USD {value} equivalent in ETB', {
              value: (rate.data!.p2pDepositMinUsdCents! / 100).toFixed(2),
            })}
          </dd>
          <dt>{translateUi('Agent withdrawals')}</dt>
          <dd>
            {translateUi('More than USD {value} equivalent in ETB', {
              value: (rate.data!.p2pWithdrawalAboveUsdCents! / 100).toFixed(2),
            })}
          </dd>
          <dt>{translateUi('Crypto deposit minimum')}</dt>
          <dd>
            {translateUi('{value} USDT', {
              value: (rate.data!.cryptoDepositMinUsdCents! / 100).toFixed(2),
            })}
          </dd>
          <dt>{translateUi('Crypto withdrawals')}</dt>
          <dd>
            {translateUi('More than {value} USDT', {
              value: (rate.data!.cryptoWithdrawalAboveUsdCents! / 100).toFixed(2),
            })}
          </dd>
        </dl>
      )}
      <p>
        {translateUi(
          'Practice balances have no cash value. Payment account approval and funding availability are managed in payment setup.'
        )}
      </p>
    </section>
  );
}
