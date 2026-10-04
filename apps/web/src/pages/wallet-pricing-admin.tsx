import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { currencyMinorDigits } from '@/lib/payment-money';
import { walletError } from '@/hooks/use-wallet-action';

type Country = { id: string; name: string; currencyCode: string; usdPricingEnabled: boolean };
type Bundle = {
  id: string;
  name: string;
  coinAmount: number;
  isActive: boolean;
  displayOrder: number;
  featured: boolean;
  usdDisplay: string;
};
const get = async <T,>(path: string) => unwrapData(await api.get<T>(path));

/** Uses the existing admin configuration permission and audit trail. */
export function WalletPricingAdmin() {
  const countries = useQuery({
    queryKey: ['payments', 'admin-countries'],
    queryFn: () => get<Country[]>('/agent-config/admin/countries'),
  });
  const bundles = useQuery({
    queryKey: ['payments', 'admin-packages'],
    queryFn: () => get<Bundle[]>('/agent-config/admin/coin-packages'),
  });
  const [countryId, setCountry] = useState(''),
    [rate, setRate] = useState(''),
    [source, setSource] = useState('');
  const [observed, setObserved] = useState(''),
    [depositMin, setDepositMin] = useState('2'),
    [withdrawAbove, setWithdrawAbove] = useState('4');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const country = countries.data?.find((c) => c.id === countryId);
  async function publish() {
    if (!country) return;
    setBusy(true);
    setMessage('');
    try {
      const observedAt = new Date(observed).toISOString();
      await boundedRequest((signal) =>
        api.post(
          `/agent-config/countries/${countryId}/usd-rates`,
          {
            version: 'USD_V1',
            coinsPerUsd: 96,
            localPerUsd: rate,
            minorDigits: currencyMinorDigits(country.currencyCode),
            source,
            observedAt,
            expiresAt: new Date(Date.parse(observedAt) + 86400000).toISOString(),
            p2pDepositMinUsdCents: Number(depositMin) * 100,
            p2pWithdrawalAboveUsdCents: Number(withdrawAbove) * 100,
            cryptoDepositMinUsdCents: 1000,
            cryptoWithdrawalAboveUsdCents: 2000,
            feeMinor: 0,
          },
          undefined,
          { signal }
        )
      );
      setMessage(
        'USD rate published. Existing transactions retain their prices. Country payment availability is unchanged.'
      );
      await countries.refetch();
    } catch (e) {
      setMessage(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveBundle() {
    if (!bundle) return;
    setBusy(true);
    setMessage('');
    try {
      const { name, coinAmount, isActive, displayOrder, featured } = bundle;
      await boundedRequest((signal) =>
        api.post(
          `/agent-config/admin/coin-packages/${bundle.id}`,
          { name, coinAmount, isActive, displayOrder, featured },
          undefined,
          { signal }
        )
      );
      await bundles.refetch();
      setBundle(null);
      setMessage('Coin package updated. USD reference price follows 96 Coins per USD.');
    } catch (e) {
      setMessage(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="payment-panel">
      <h2>Pricing configuration</h2>
      <p>
        96 Coins = USD 1. Fees remain zero. Crypto checkout and automated FX updates require a
        verified provider integration.
      </p>
      {(countries.isError || bundles.isError) && (
        <p role="alert">
          Configuration could not load.{' '}
          <button
            onClick={() => {
              void countries.refetch();
              void bundles.refetch();
            }}
          >
            Retry
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <details>
        <summary>Publish a verified local currency rate</summary>
        <p>
          Publishing activates USD pricing for this country permanently. It does not enable
          payments. Rates expire 24 hours after observation; publish a fresh verified rate before
          expiry.
        </p>
        <label>
          Country
          <select value={countryId} disabled={busy} onChange={(e) => setCountry(e.target.value)}>
            <option value="">Choose a country</option>
            {countries.data?.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name} · {c.currencyCode}
                {c.usdPricingEnabled ? ' · USD pricing' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Local currency per USD
          <input
            value={rate}
            inputMode="decimal"
            onChange={(e) => setRate(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Verified source / reference
          <input
            value={source}
            maxLength={200}
            onChange={(e) => setSource(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Observation time (your local time)
          <input
            type="datetime-local"
            value={observed}
            onChange={(e) => setObserved(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Minimum deposit (USD, at least 2)
          <input
            value={depositMin}
            inputMode="decimal"
            onChange={(e) => setDepositMin(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Withdrawal must exceed (USD, at least 4)
          <input
            value={withdrawAbove}
            inputMode="decimal"
            onChange={(e) => setWithdrawAbove(e.target.value)}
            disabled={busy}
          />
        </label>
        <button
          disabled={busy || !country || !rate || !source || !observed}
          onClick={() => void publish()}
        >
          Publish rate and activate USD pricing
        </button>
      </details>
      <details>
        <summary>Manage Coin bundles</summary>
        {bundles.isPending ? (
          <p>Loading bundles…</p>
        ) : (
          bundles.data?.map((b) => (
            <p key={b.id}>
              {b.name} · {b.coinAmount} Coins ≈ USD {b.usdDisplay} ·{' '}
              {b.isActive ? 'Enabled' : 'Disabled'}{' '}
              <button disabled={busy} onClick={() => setBundle({ ...b })}>
                Edit {b.name}
              </button>
            </p>
          ))
        )}
        {bundle && (
          <div>
            <label>
              Package name
              <input
                value={bundle.name}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setBundle({ ...bundle, name: e.target.value })}
              />
            </label>
            <label>
              Coins
              <input
                type="number"
                min="1"
                max="1000000000"
                value={bundle.coinAmount}
                disabled={busy}
                onChange={(e) => setBundle({ ...bundle, coinAmount: Number(e.target.value) })}
              />
            </label>
            <label>
              Display order
              <input
                type="number"
                min="0"
                max="10000"
                value={bundle.displayOrder}
                disabled={busy}
                onChange={(e) => setBundle({ ...bundle, displayOrder: Number(e.target.value) })}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={bundle.isActive}
                disabled={busy}
                onChange={(e) => setBundle({ ...bundle, isActive: e.target.checked })}
              />{' '}
              Enabled
            </label>
            <label>
              <input
                type="checkbox"
                checked={bundle.featured}
                disabled={busy}
                onChange={(e) => setBundle({ ...bundle, featured: e.target.checked })}
              />{' '}
              Featured
            </label>
            <button disabled={busy} onClick={() => void saveBundle()}>
              Save package
            </button>
            <button disabled={busy} onClick={() => setBundle(null)}>
              Cancel
            </button>
          </div>
        )}
      </details>
    </section>
  );
}
