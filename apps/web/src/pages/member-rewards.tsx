import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Gift, Users, Copy, ArrowUpRight, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { memberGet, memberDate, rewardLabels, type RewardSummary } from '@/lib/member-rewards';
import { PRACTICE_ETB } from '@/lib/practice-etb';
import './lounge.css';
import './member-account.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function MemberRewardsPage() {
  const { user } = useAuth();
  return user ? <RewardsSession key={user.id} userId={user.id} /> : null;
}
function RewardsSession({ userId }: { userId: string }) {
  const {
    t: translateUi,
    locale: interfaceLocale,
    formatMinorCurrency: formatEtb,
  } = useInterfaceLanguage();

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
        {translateUi('Loading your rewards…')}
      </div>
    );
  if (query.isError)
    return (
      <div className="member-account member-panel" role="alert">
        <h1>{translateUi('Rewards could not be loaded')}</h1>
        <button className="salem-button" onClick={() => query.refetch()}>
          {translateUi('Try again')}
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
      {enabled ? translateUi('Automatic') : translateUi('Unavailable')}
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
          <span className="salem-eyebrow">{translateUi('YOUR MEMBERSHIP')}</span>
          <h1>{translateUi('Rewards, made for you.')}</h1>
          <p>
            {translateUi('Earn Birr automatically through daily activity, gifts, and invitations.')}
          </p>
        </div>
        <Link className="salem-button secondary" to="/profile">
          {translateUi('My profile') + ' '}
          <ArrowUpRight size={16} />
        </Link>
      </header>
      <section className="member-balance-band" aria-label={translateUi('Reward balances')}>
        <div>
          <span>{translateUi('Bonus Birr · bets only')}</span>
          <strong>{formatEtb(d.wallet.coinAvailability?.betOnly)}</strong>
          <small>{translateUi('Reward principal cannot be withdrawn.')}</small>
        </div>
        <div>
          <span>{translateUi('Available cash balance')}</span>
          <strong>{formatEtb(d.wallet.coinAvailability?.spendable)}</strong>
          <small>{translateUi('Withdrawals follow your account eligibility.')}</small>
        </div>
        <div>
          <span>{translateUi('Rewards processing')}</span>
          <strong>{formatEtb(d.pendingMinor)}</strong>
          <small>
            {translateUi('All-time promotion rewards: {value}', {
              value: formatEtb(d.earnedMinor),
            })}
          </small>
        </div>
      </section>
      {!d.eligibility.canClaim && d.pendingMinor > 0 && (
        <div className="member-notice">
          <ShieldCheck size={20} aria-hidden="true" />
          <p>
            {translateUi(
              'Your earned rewards are saved. They will be credited automatically when your reward wallet is available.'
            )}
          </p>
        </div>
      )}
      {notice && (
        <p className="member-feedback" role="status">
          {translateUi(notice)}
        </p>
      )}
      <section className="member-reward-grid" aria-label={translateUi('Ways to earn')}>
        <article className="member-panel member-reward-card">
          <div className="member-card-top">
            <CalendarCheck aria-hidden="true" />
            {status(c.daily_enabled)}
          </div>
          <h2>{translateUi('Daily activity')}</h2>
          <strong className="member-reward-amount">
            {c.daily_enabled ? formatEtb(c.daily_amount) : translateUi('Currently unavailable')}
          </strong>
          <p>
            {translateUi(
              'Log in or use Salem Bet each day. Your daily reward is added automatically, once per day. Resets at midnight in Addis Ababa (UTC+3).'
            )}
          </p>
          <div className="member-rule">
            <strong>
              {d.today?.claimed_at
                ? translateUi('Today’s reward credited')
                : d.today
                  ? translateUi('Today’s reward is processing')
                  : c.daily_enabled
                    ? translateUi('Your daily activity is recorded automatically')
                    : translateUi('Daily rewards are currently unavailable')}
            </strong>
          </div>
          <small>
            {translateUi('Next reset: {value}', {
              value: new Date(d.nextCheckInAt).toLocaleString(interfaceLocale),
            })}
          </small>
        </article>
        <article className="member-panel member-reward-card">
          <div className="member-card-top">
            <Gift aria-hidden="true" />
            {status(c.gift_enabled)}
          </div>
          <h2>{translateUi('Gift purchase')}</h2>
          <strong className="member-reward-amount">
            {c.gift_enabled ? formatEtb(c.gift_amount) : translateUi('Currently unavailable')}
          </strong>
          <p>
            {translateUi('Earn automatically after each qualifying real-Birr gift purchase.')}
            {c.gift_minimum > 0 &&
              ' ' + translateUi('Minimum purchase: {value}.', { value: formatEtb(c.gift_minimum) })}
          </p>
          {c.gift_enabled && (
            <div className="member-rule">
              {translateUi('Daily gift reward limit') + ' '}
              <strong>{formatEtb(c.gift_daily_limit)}</strong>
            </div>
          )}
          <small>
            {PRACTICE_ETB
              ? translateUi(
                  'The current gift shop uses practice ETB. Those purchases do not qualify.'
                )
              : translateUi(
                  'Practice ETB, game points, and reward-funded purchases do not qualify.'
                )}
          </small>
        </article>
        <article className="member-panel member-reward-card featured">
          <div className="member-card-top">
            <Users aria-hidden="true" />
            {status(c.referral_enabled)}
          </div>
          <h2>{translateUi('Invite a friend')}</h2>
          <strong className="member-reward-amount">
            {c.referral_enabled
              ? formatEtb(c.referral_amount)
              : translateUi('Currently unavailable')}
          </strong>
          <p>
            {translateUi(
              'Earn automatically for each friend who signs up with your code and completes their first qualifying real-Birr gift purchase.'
            )}
          </p>
          <div className="member-rule">
            <span>{translateUi('{referrals} joined', { referrals: d.referrals })}</span>
            <strong>
              {translateUi('{qualifiedReferrals} qualified', {
                qualifiedReferrals: d.qualifiedReferrals,
              })}
            </strong>
          </div>
          <small>
            {c.gift_minimum > 0 &&
              translateUi('Minimum purchase: {value}.', { value: formatEtb(c.gift_minimum) }) + ' '}
            {translateUi('One reward per invited friend while this offer is available.')}
          </small>
        </article>
      </section>
      <section className="member-panel member-invite">
        <div>
          <span className="salem-eyebrow">{translateUi('GROW YOUR CIRCLE')}</span>
          <h2>{translateUi('Your invitation link')}</h2>
          <p>
            {translateUi(
              'Share this link before your friend creates an account. Only their first qualifying purchase earns you a referral reward.'
            )}
          </p>
        </div>
        <div className="member-invite-actions">
          {d.referralCode ? (
            <>
              <label htmlFor="referral-link">
                {translateUi('Your code:') + ' '}
                <strong>{d.referralCode}</strong>
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
                  {translateUi('Copy link')}
                </button>
              </div>
            </>
          ) : (
            <button
              className="salem-button"
              disabled={action.isPending}
              onClick={() => action.mutate()}
            >
              {translateUi('Create my referral link')}
            </button>
          )}
        </div>
      </section>
      <section className="member-panel">
        <div className="member-section-title">
          <h2>{translateUi('Reward history')}</h2>
          <span className="member-muted">{translateUi('Amounts in Ethiopian Birr')}</span>
        </div>
        {!d.history.length ? (
          <div className="member-empty">
            <Gift size={28} aria-hidden="true" />
            <h3>{translateUi('Your rewards will appear here')}</h3>
            <p>
              {translateUi(
                'Rewards are added automatically when you complete an eligible activity.'
              )}
            </p>
          </div>
        ) : (
          <ul className="member-history">
            {d.history.map((row) => (
              <li key={row.id}>
                <div>
                  <strong>{translateUi(rewardLabels[row.kind])}</strong>
                  <small>{translateUi(memberDate(row.created_at, interfaceLocale))}</small>
                </div>
                <strong>{formatEtb(row.amount)}</strong>
                <span className={`member-pill ${row.claimed_at ? 'active' : ''}`}>
                  {row.claimed_at
                    ? translateUi('Credited')
                    : translateUi('Processing automatically')}
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
              {translateUi('Previous')}
            </button>
            <span>{translateUi('Page {value}', { value: page + 1 })}</span>
            <button
              className="salem-button secondary"
              disabled={!d.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              {translateUi('Next')}
            </button>
          </div>
        )}
      </section>
      <section className="member-panel member-terms">
        <ShieldCheck aria-hidden="true" />
        <div>
          <h2>{translateUi('How reward Birr works')}</h2>
          <p>
            {translateUi(
              'Use bonus Birr for eligible real-money bets. The reward itself, returned stakes, and refunds remain non-withdrawable. Only verified net winnings can enter your cash balance, subject to withdrawal checks. Practice games and casino demos never produce withdrawable winnings.'
            )}
          </p>
          <p>
            {translateUi(
              '{value} Reward rates apply to future activity; already-earned amounts stay the same.',
              {
                value:
                  d.eligibility.expiryHours !== null
                    ? translateUi(
                        'Credited bonus Birr expires after {expiryHours} hours under your current account rules.',
                        { expiryHours: d.eligibility.expiryHours }
                      )
                    : d.eligibility.canClaim
                      ? translateUi('Your current reward wallet has no bonus expiry.')
                      : translateUi(
                          'Any expiry terms are shown when your reward wallet becomes available.'
                        ),
              }
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
