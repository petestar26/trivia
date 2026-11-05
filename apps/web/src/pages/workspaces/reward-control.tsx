import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { memberGet, memberDate, type RewardConfig } from '@/lib/member-rewards';
import { formatEtb } from '@/lib/payment-money';
import { getErrorMessage } from '@/lib/error-message';
import { useAuth } from '@/providers/auth-provider';
import '../member-account.css';
import '../lounge.css';

type AdminRewards = {
  config: RewardConfig;
  gates: { key: string; enabled: boolean }[];
  history: {
    id: string;
    createdAt: string;
    user: { username: string } | null;
    newData: RewardConfig;
  }[];
};
const amounts = [
  'daily_amount',
  'gift_amount',
  'gift_daily_limit',
  'referral_amount',
  'gift_minimum',
] as const;
type AmountKey = (typeof amounts)[number];
const titles: Record<AmountKey, string> = {
  daily_amount: 'Daily reward (Birr)',
  gift_amount: 'Reward per gift purchase (Birr)',
  gift_daily_limit: 'Gift reward limit per user per day (Birr)',
  referral_amount: 'Reward per qualified referral (Birr)',
  gift_minimum: 'Minimum qualifying gift purchase (Birr)',
};
function toMinor(value: string) {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(value.trim()))
    throw new Error('Enter a Birr amount with no more than two decimal places.');
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (amount > 100_000_000) throw new Error('Amounts must be at most 1,000,000 Birr.');
  return amount;
}
export function RewardControlPage() {
  const { user } = useAuth();
  const cache = useQueryClient();
  const [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: ['admin-rewards', user?.id],
    queryFn: () => memberGet<AdminRewards>('/member-rewards/admin'),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  if (query.isPending) return <div role="status">Loading reward controls…</div>;
  if (query.isError)
    return (
      <div role="alert">
        <h1>Reward controls unavailable</h1>
        <button onClick={() => query.refetch()}>Try again</button>
      </div>
    );
  const d = query.data;
  return (
    <div className="salem-lounge member-account">
      <header className="member-heading">
        <div>
          <span className="salem-eyebrow">MEMBER PROGRAMS</span>
          <h1>Reward control</h1>
          <p>Set platform-wide Birr rewards for daily activity, gift purchases, and referrals.</p>
        </div>
        <div className="member-actions">
          <span className="member-pill">Settings version {d.config.version}</span>
          <button className="salem-button secondary" onClick={() => query.refetch()}>
            Reload settings
          </button>
        </div>
      </header>
      <div className="member-notice">
        <p>
          Set these rates once for the whole platform. Eligible members receive rewards
          automatically, without individual approvals or manual payouts. You can increase or reduce
          the rates here at any time. All rewards are bonus Birr for eligible bets. Principal,
          returned stakes, and refunds are non-withdrawable; verified net winnings may be withdrawn.
          Only real-Birr gift purchases qualify. Settings affect future activity and never change
          rewards already earned.
        </p>
      </div>
      <section className="member-panel">
        <h2>Financial service availability</h2>
        <div className="member-details" style={{ marginTop: 18 }}>
          {[
            ['BONUS_GRANT', 'Reward wallet'],
            ['CASINO_PLAY', 'Real-money play'],
            ['WITHDRAWAL_CREATE', 'Withdrawals'],
          ].map(([key, title]) => (
            <div key={key}>
              <p>{title}</p>
              <span
                className={`member-pill ${d.gates.some((g) => g.key === key && g.enabled) ? 'active' : ''}`}
              >
                {d.gates.some((g) => g.key === key && g.enabled) ? 'Enabled' : 'Not enabled'}
              </span>
            </div>
          ))}
        </div>
        <p className="member-muted" style={{ marginTop: 16 }}>
          These settings do not activate payment or gaming services. If a member’s reward wallet is
          unavailable, earned rewards are saved and automatically retried until they can be
          credited.
        </p>
      </section>
      <RewardForm
        key={d.config.version}
        config={d.config}
        onSaved={async () => {
          setNotice('Reward settings saved.');
          await cache.invalidateQueries({ queryKey: ['admin-rewards', user?.id] });
        }}
      />
      {notice && (
        <p className="member-feedback" role="status">
          {notice}
        </p>
      )}
      <section className="member-panel">
        <h2>Recent changes</h2>
        {!d.history.length ? (
          <p className="member-muted">No reward settings have been changed yet.</p>
        ) : (
          <ul className="member-history">
            {d.history.map((row) => (
              <li key={row.id}>
                <div>
                  <strong>
                    Version {row.newData.version} · {row.user?.username || 'Administrator'}
                  </strong>
                  <small>{memberDate(row.createdAt)}</small>
                  <small>
                    Daily {row.newData.daily_enabled ? formatEtb(row.newData.daily_amount) : 'off'}{' '}
                    · Gift {row.newData.gift_enabled ? formatEtb(row.newData.gift_amount) : 'off'} ·
                    Referral{' '}
                    {row.newData.referral_enabled ? formatEtb(row.newData.referral_amount) : 'off'}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
function RewardForm({ config, onSaved }: { config: RewardConfig; onSaved: () => Promise<void> }) {
  const [enabled, setEnabled] = useState({
    daily_enabled: config.daily_enabled,
    gift_enabled: config.gift_enabled,
    referral_enabled: config.referral_enabled,
  });
  const [values, setValues] = useState<Record<AmountKey, string>>(
    () =>
      Object.fromEntries(amounts.map((key) => [key, (config[key] / 100).toFixed(2)])) as Record<
        AmountKey,
        string
      >
  );
  const [notice, setNotice] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        version: config.version,
        ...enabled,
        ...Object.fromEntries(amounts.map((key) => [key, toMinor(values[key])])),
      };
      return unwrapData(await api.put('/member-rewards/admin', payload));
    },
    onSuccess: async () => {
      setNotice('Reward settings saved.');
      await onSaved();
    },
    onError: (error) => setNotice(getErrorMessage(error, 'Settings could not be saved.')),
  });
  const field = (key: AmountKey) => (
    <label key={key}>
      {titles[key]}
      <input
        inputMode="decimal"
        autoComplete="off"
        required
        value={values[key]}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
      />
    </label>
  );
  const toggle = (key: keyof typeof enabled, title: string) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 15 }}>
      <input
        style={{ width: 18, height: 18 }}
        type="checkbox"
        checked={enabled[key]}
        onChange={(e) => setEnabled((v) => ({ ...v, [key]: e.target.checked }))}
      />
      {title}
    </label>
  );
  return (
    <form
      className="member-edit"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset disabled={save.isPending} className="member-reward-grid">
        <section className="member-panel member-edit">
          {toggle('daily_enabled', 'Enable daily rewards')}
          {field('daily_amount')}
          <small>
            Automatically credited once per active member per day. The day resets at midnight in
            Addis Ababa.
          </small>
        </section>
        <section className="member-panel member-edit">
          {toggle('gift_enabled', 'Enable gift rewards')}
          {field('gift_amount')}
          {field('gift_daily_limit')}
          <small>
            One fixed reward per qualifying purchase, up to the daily limit. A gift quantity does
            not multiply the reward.
          </small>
        </section>
        <section className="member-panel member-edit">
          {toggle('referral_enabled', 'Enable referral rewards')}
          {field('referral_amount')}
          <small>
            One reward to the inviter after their friend’s first qualifying purchase while this
            program is enabled.
          </small>
        </section>
      </fieldset>
      <section className="member-panel member-edit">
        {field('gift_minimum')}
        <small>
          Applies to gift and referral rewards. Free practice ETB, game points, and bonus principal
          cannot qualify. Only completed purchases count.
        </small>
        <div className="member-actions">
          <button className="salem-button" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save reward settings'}
          </button>
          <span className="member-muted">Last updated {memberDate(config.updated_at)}</span>
        </div>
        {notice && (
          <p className="member-feedback" role="status">
            {notice}
          </p>
        )}
      </section>
    </form>
  );
}
