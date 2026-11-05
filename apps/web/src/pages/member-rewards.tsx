import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Gift, Users, Copy, ArrowUpRight, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { formatEtb } from '@/lib/payment-money';
import { getErrorMessage } from '@/lib/error-message';
import { memberGet, memberDate, rewardLabels, type RewardSummary } from '@/lib/member-rewards';
import { PRACTICE_ETB } from '@/lib/practice-etb';
import './lounge.css';
import './member-account.css';

export function MemberRewardsPage() {
  const { user } = useAuth();
  return user ? <RewardsSession key={user.id} userId={user.id} /> : null;
}
function RewardsSession({ userId }: { userId: string }) {
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState('');
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ['member-rewards', userId, page],
    queryFn: () => memberGet<RewardSummary>(`/member-rewards?page=${page}`),
    staleTime: 0,
    retry: false,
    refetchInterval: 30_000,
  });
  const action = useMutation({
    mutationFn: async () => {
      unwrapData(await api.post('/member-rewards/referral-code', {}));
      return 'Your referral link is ready.';
    },
    onSuccess: (message) => setNotice(message),
    onError: (error) =>
      setNotice(getErrorMessage(error, 'Could not complete this request. Please try again.')),
    onSettled: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['member-rewards', userId] }),
        cache.invalidateQueries({ queryKey: ['wallet'] }),
      ]);
    },
  });
  if (query.isPending)
    return (
      <div className="member-account" role="status">
        Loading your rewards…
      </div>
    );
  if (query.isError)
    return (
      <div className="member-account member-panel" role="alert">
        <h1>Rewards could not be loaded</h1>
        <button className="salem-button" onClick={() => query.refetch()}>
          Try again
        </button>
      </div>
    );
  const d = query.data,
    c = d.config;
  const referralUrl = d.referralCode
    ? `${window.location.origin}/register?ref=${encodeURIComponent(d.referralCode)}`
    : '';
  const status = (enabled: boolean) => (
    <span className={`member-pill ${enabled ? 'active' : ''}`}>
      {enabled ? 'Automatic' : 'Unavailable'}
    </span>
  );
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(referralUrl);
      setNotice('Referral link copied.');
    } catch {
      setNotice('Copy the referral link from the field below.');
    }
  }
  return (
    <div className="salem-lounge member-account">
      <header className="member-heading">
        <div>
          <span className="salem-eyebrow">YOUR MEMBERSHIP</span>
          <h1>Rewards, made for you.</h1>
          <p>Earn Birr automatically through daily activity, gifts, and invitations.</p>
        </div>
        <Link className="salem-button secondary" to="/profile">
          My profile <ArrowUpRight size={16} />
        </Link>
      </header>
      <section className="member-balance-band" aria-label="Reward balances">
        <div>
          <span>Bonus Birr · bets only</span>
          <strong>{formatEtb(d.wallet.coinAvailability?.betOnly)}</strong>
          <small>Reward principal cannot be withdrawn.</small>
        </div>
        <div>
          <span>Available cash balance</span>
          <strong>{formatEtb(d.wallet.coinAvailability?.spendable)}</strong>
          <small>Withdrawals follow your account eligibility.</small>
        </div>
        <div>
          <span>Rewards processing</span>
          <strong>{formatEtb(d.pendingMinor)}</strong>
          <small>All-time promotion rewards: {formatEtb(d.earnedMinor)}</small>
        </div>
      </section>
      {!d.eligibility.canClaim && d.pendingMinor > 0 && (
        <div className="member-notice">
          <ShieldCheck size={20} aria-hidden="true" />
          <p>
            Your earned rewards are saved. They will be credited automatically when your reward
            wallet is available.
          </p>
        </div>
      )}
      {notice && (
        <p className="member-feedback" role="status">
          {notice}
        </p>
      )}
      <section className="member-reward-grid" aria-label="Ways to earn">
        <article className="member-panel member-reward-card">
          <div className="member-card-top">
            <CalendarCheck aria-hidden="true" />
            {status(c.daily_enabled)}
          </div>
          <h2>Daily activity</h2>
          <strong className="member-reward-amount">
            {c.daily_enabled ? formatEtb(c.daily_amount) : 'Currently unavailable'}
          </strong>
          <p>
            Log in or use Salem Bet each day. Your daily reward is added automatically, once per
            day. Resets at midnight in Addis Ababa (UTC+3).
          </p>
          <div className="member-rule">
            <strong>
              {d.today?.claimed_at
                ? 'Today’s reward credited'
                : d.today
                  ? 'Today’s reward is processing'
                  : c.daily_enabled
                    ? 'Your daily activity is recorded automatically'
                    : 'Daily rewards are currently unavailable'}
            </strong>
          </div>
          <small>Next reset: {new Date(d.nextCheckInAt).toLocaleString()}</small>
        </article>
        <article className="member-panel member-reward-card">
          <div className="member-card-top">
            <Gift aria-hidden="true" />
            {status(c.gift_enabled)}
          </div>
          <h2>Gift purchase</h2>
          <strong className="member-reward-amount">
            {c.gift_enabled ? formatEtb(c.gift_amount) : 'Currently unavailable'}
          </strong>
          <p>
            Earn automatically after each qualifying real-Birr gift purchase.
            {c.gift_minimum > 0 && ` Minimum purchase: ${formatEtb(c.gift_minimum)}.`}
          </p>
          {c.gift_enabled && (
            <div className="member-rule">
              Daily gift reward limit <strong>{formatEtb(c.gift_daily_limit)}</strong>
            </div>
          )}
          <small>
            {PRACTICE_ETB
              ? 'The current gift shop uses practice ETB. Those purchases do not qualify.'
              : 'Practice ETB, game points, and reward-funded purchases do not qualify.'}
          </small>
        </article>
        <article className="member-panel member-reward-card featured">
          <div className="member-card-top">
            <Users aria-hidden="true" />
            {status(c.referral_enabled)}
          </div>
          <h2>Invite a friend</h2>
          <strong className="member-reward-amount">
            {c.referral_enabled ? formatEtb(c.referral_amount) : 'Currently unavailable'}
          </strong>
          <p>
            Earn automatically for each friend who signs up with your code and completes their first
            qualifying real-Birr gift purchase.
          </p>
          <div className="member-rule">
            <span>{d.referrals} joined</span>
            <strong>{d.qualifiedReferrals} qualified</strong>
          </div>
          <small>
            {c.gift_minimum > 0 && `Minimum purchase: ${formatEtb(c.gift_minimum)}. `}
            One reward per invited friend while this offer is available.
          </small>
        </article>
      </section>
      <section className="member-panel member-invite">
        <div>
          <span className="salem-eyebrow">GROW YOUR CIRCLE</span>
          <h2>Your invitation link</h2>
          <p>
            Share this link before your friend creates an account. Only their first qualifying
            purchase earns you a referral reward.
          </p>
        </div>
        <div className="member-invite-actions">
          {d.referralCode ? (
            <>
              <label htmlFor="referral-link">
                Your code: <strong>{d.referralCode}</strong>
              </label>
              <div className="member-copy">
                <input
                  id="referral-link"
                  readOnly
                  value={referralUrl}
                  onFocus={(e) => e.target.select()}
                />
                <button className="salem-button" onClick={copyLink}>
                  <Copy size={16} aria-hidden="true" />
                  Copy link
                </button>
              </div>
            </>
          ) : (
            <button
              className="salem-button"
              disabled={action.isPending}
              onClick={() => action.mutate()}
            >
              Create my referral link
            </button>
          )}
        </div>
      </section>
      <section className="member-panel">
        <div className="member-section-title">
          <h2>Reward history</h2>
          <span className="member-muted">Amounts in Ethiopian Birr</span>
        </div>
        {!d.history.length ? (
          <div className="member-empty">
            <Gift size={28} aria-hidden="true" />
            <h3>Your rewards will appear here</h3>
            <p>Rewards are added automatically when you complete an eligible activity.</p>
          </div>
        ) : (
          <ul className="member-history">
            {d.history.map((row) => (
              <li key={row.id}>
                <div>
                  <strong>{rewardLabels[row.kind]}</strong>
                  <small>{memberDate(row.created_at)}</small>
                </div>
                <strong>{formatEtb(row.amount)}</strong>
                <span className={`member-pill ${row.claimed_at ? 'active' : ''}`}>
                  {row.claimed_at ? 'Credited' : 'Processing automatically'}
                </span>
              </li>
            ))}
          </ul>
        )}
        {(page > 0 || d.hasMore) && (
          <div className="member-pagination">
            <button
              className="salem-button secondary"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              className="salem-button secondary"
              disabled={!d.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        )}
      </section>
      <section className="member-panel member-terms">
        <ShieldCheck aria-hidden="true" />
        <div>
          <h2>How reward Birr works</h2>
          <p>
            Use bonus Birr for eligible real-money bets. The reward itself, returned stakes, and
            refunds remain non-withdrawable. Only verified net winnings can enter your cash balance,
            subject to withdrawal checks. Practice games and casino demos never produce withdrawable
            winnings.
          </p>
          <p>
            {d.eligibility.expiryHours !== null
              ? `Credited bonus Birr expires after ${d.eligibility.expiryHours} hours under your current account rules.`
              : d.eligibility.canClaim
                ? 'Your current reward wallet has no bonus expiry.'
                : 'Any expiry terms are shown when your reward wallet becomes available.'}{' '}
            Reward rates apply to future activity; already-earned amounts stay the same.
          </p>
        </div>
      </section>
    </div>
  );
}
