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
import { RewardsPage } from './rewards';
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
  });
  const action = useMutation({
    mutationFn: async ({ path, claimDaily = false }: { path: string; claimDaily?: boolean }) => {
      const result = unwrapData(await api.post<{ id?: string }>(path, {}));
      if (claimDaily && result.id && query.data?.eligibility.canClaim) {
        unwrapData(await api.post(`/member-rewards/${result.id}/claim`, {}));
        return 'Your daily reward is now in your bonus balance.';
      }
      return claimDaily
        ? 'Checked in. Your reward is earned and remains pending until your reward wallet is available.'
        : 'Saved successfully.';
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
      {enabled ? 'Available' : 'Not enabled'}
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
          <p>Every earned Birr, every invitation, all in one place.</p>
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
          <span>Earned, awaiting claim</span>
          <strong>{formatEtb(d.pendingMinor)}</strong>
          <small>All-time promotion rewards: {formatEtb(d.earnedMinor)}</small>
        </div>
      </section>
      {!d.eligibility.canClaim && (
        <div className="member-notice">
          <ShieldCheck size={20} aria-hidden="true" />
          <p>
            Your reward wallet is not available yet. Earned rewards stay pending. An active payment
            country and enabled reward service are required to claim them.
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
          <h2>Daily check-in</h2>
          <strong className="member-reward-amount">
            {c.daily_amount ? formatEtb(c.daily_amount) : 'Awaiting admin amount'}
          </strong>
          <p>
            Log in or check in while you are active, once each day. Resets at midnight in Addis
            Ababa (UTC+3).
          </p>
          <button
            className="salem-button"
            disabled={!c.daily_enabled || !!d.today || action.isPending}
            onClick={() => action.mutate({ path: '/member-rewards/daily', claimDaily: true })}
          >
            {d.today ? 'Checked in today' : action.isPending ? 'Please wait…' : 'Check in & earn'}
          </button>
          <small>Next reset: {new Date(d.nextCheckInAt).toLocaleString()}</small>
        </article>
        <article className="member-panel member-reward-card">
          <div className="member-card-top">
            <Gift aria-hidden="true" />
            {status(c.gift_enabled)}
          </div>
          <h2>Gift purchase</h2>
          <strong className="member-reward-amount">
            {c.gift_amount ? formatEtb(c.gift_amount) : 'Awaiting admin amount'}
          </strong>
          <p>
            Earn for each completed real-Birr gift purchase of at least {formatEtb(c.gift_minimum)}.
          </p>
          <div className="member-rule">
            Daily gift reward limit <strong>{formatEtb(c.gift_daily_limit)}</strong>
          </div>
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
            {c.referral_amount ? formatEtb(c.referral_amount) : 'Awaiting admin amount'}
          </strong>
          <p>
            Earn once for each friend who signs up with your code and completes their first
            qualifying real-Birr gift purchase.
          </p>
          <div className="member-rule">
            <span>{d.referrals} joined</span>
            <strong>{d.qualifiedReferrals} qualified</strong>
          </div>
          <small>
            Minimum purchase: {formatEtb(c.gift_minimum)}. Referral rewards must be enabled when the
            qualifying purchase is made.
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
              onClick={() => action.mutate({ path: '/member-rewards/referral-code' })}
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
            <p>Check in or complete an eligible activity when its reward is enabled.</p>
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
                {row.claimed_at ? (
                  <span className="member-pill active">Claimed</span>
                ) : (
                  <button
                    className="salem-button secondary"
                    disabled={action.isPending || !d.eligibility.canClaim}
                    onClick={() => action.mutate({ path: `/member-rewards/${row.id}/claim` })}
                  >
                    {d.eligibility.canClaim ? 'Claim reward' : 'Pending'}
                  </button>
                )}
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
              ? `Claimed bonus Birr expires after ${d.eligibility.expiryHours} hours under your current account rules.`
              : d.eligibility.canClaim
                ? 'Your current reward wallet has no bonus expiry.'
                : 'Any expiry terms are shown when your reward wallet becomes available.'}{' '}
            Admin changes apply to future earning activity; already-earned amounts stay the same.
          </p>
        </div>
      </section>
      <details className="member-panel member-activity">
        <summary>Activity, achievements & membership level</summary>
        <RewardsPage />
      </details>
    </div>
  );
}
