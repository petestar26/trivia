import { useQuery } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';

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
  const rate = useQuery({
    queryKey: ['payments', 'etb-reference'],
    queryFn: async () => unwrapData(await api.get<Reference>('/wallet/exchange-rate')),
    refetchInterval: 30_000,
  });
  const fresh = rate.data?.available && Date.parse(rate.data.expiresAt ?? '') > Date.now();
  return (
    <section className="payment-panel">
      <h1>Birr wallet & exchange rate</h1>
      <p>
        Members hold one balance in ETB. Agent deposits credit Birr directly. Crypto deposits
        convert USDT to ETB using the rate shown before confirmation.
      </p>
      <div className="payment-disclosure">
        <strong>Wallet currency: Birr (ETB)</strong>
        <p>Precision: 0.01 ETB · Platform conversion fee: 0</p>
        {rate.isPending ? (
          <p role="status">Loading the exchange rate…</p>
        ) : fresh ? (
          <>
            <h2>1 USD = {rate.data!.localPerUsd} ETB</h2>
            <p>Observed {new Date(rate.data!.observedAt!).toLocaleString()}</p>
            <p>New quotes available until {new Date(rate.data!.expiresAt!).toLocaleString()}</p>
          </>
        ) : (
          <p role="status">
            {rate.data?.reason ??
              'A fresh exchange rate is unavailable. New conversion quotes are paused.'}
          </p>
        )}
        <p>
          Source:{' '}
          <a href="https://ethioblackmarket.com/" target="_blank" rel="noreferrer">
            EthioBlackMarket
          </a>
          . The server checks every 15 minutes. Rates expire 30 minutes after the source
          observation.
        </p>
        <button disabled={rate.isFetching} onClick={() => void rate.refetch()}>
          Refresh status
        </button>
      </div>
      <h2>How payments are priced</h2>
      <p>
        USDT is quoted at 1 USDT = USD 1 using the displayed USD reference. This reference is not a
        guaranteed exchange execution price. The exact ETB amount is locked when the payment request
        is created.
      </p>
      <p>
        Verified deposits credit the saved ETB amount. Later rate changes never revalue wallet
        balances. Withdrawals reserve the requested ETB amount and show the USDT payout before
        confirmation.
      </p>
      {fresh && (
        <dl>
          <dt>Agent deposit minimum</dt>
          <dd>USD {(rate.data!.p2pDepositMinUsdCents! / 100).toFixed(2)} equivalent in ETB</dd>
          <dt>Agent withdrawals</dt>
          <dd>
            More than USD {(rate.data!.p2pWithdrawalAboveUsdCents! / 100).toFixed(2)} equivalent in
            ETB
          </dd>
          <dt>Crypto deposit minimum</dt>
          <dd>{(rate.data!.cryptoDepositMinUsdCents! / 100).toFixed(2)} USDT</dd>
          <dt>Crypto withdrawals</dt>
          <dd>More than {(rate.data!.cryptoWithdrawalAboveUsdCents! / 100).toFixed(2)} USDT</dd>
        </dl>
      )}
      <p>
        Practice balances have no cash value. Payment account approval and funding availability are
        managed in payment setup.
      </p>
    </section>
  );
}
