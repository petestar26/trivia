import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, UserRound, ShieldCheck, Pencil, LogOut } from 'lucide-react';
import { AuthenticatorSetup } from '@/components/security/authenticator-setup';
import { ChangePassword } from '@/components/security/change-password';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { memberGet, memberDate, type RewardSummary } from '@/lib/member-rewards';
import { formatEtb } from '@/lib/payment-money';
import { getErrorMessage } from '@/lib/error-message';
import './lounge.css';
import './member-account.css';

type Profile = {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  email: string | null;
  phone: string | null;
  phoneVerified: boolean;
  isVerified: boolean;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
  signInMethods: string[];
  payoutCountry: { name: string; currencyCode: string } | null;
  kycVerification: { status: string; verifiedTier: number } | null;
};
const label = (value: string) =>
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
export function ProfilePage() {
  const { user } = useAuth();
  return user ? <ProfileSession key={user.id} userId={user.id} /> : <p>Not signed in.</p>;
}
function ProfileSession({ userId }: { userId: string }) {
  const { logout, refreshUser } = useAuth();
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [notice, setNotice] = useState('');
  const profile = useQuery({
    queryKey: ['member-profile', userId],
    queryFn: () => memberGet<Profile>('/member-profile'),
    staleTime: 0,
    retry: false,
  });
  const rewards = useQuery({
    queryKey: ['member-rewards', userId, 0],
    queryFn: () => memberGet<RewardSummary>('/member-rewards?page=0'),
    staleTime: 0,
    retry: false,
  });
  const save = useMutation({
    mutationFn: async () =>
      unwrapData(
        await api.patch('/member-profile', { displayName: displayName.trim(), bio: bio.trim() })
      ),
    onSuccess: async () => {
      setEditing(false);
      setNotice('Profile saved.');
      await cache.invalidateQueries({ queryKey: ['member-profile', userId] });
      await refreshUser();
    },
    onError: (error) => setNotice(getErrorMessage(error, 'Your profile could not be saved.')),
  });
  if (profile.isPending)
    return (
      <div className="member-account" role="status">
        Loading your profile…
      </div>
    );
  if (profile.isError)
    return (
      <div className="member-account member-panel" role="alert">
        <h1>Profile could not be loaded</h1>
        <button className="salem-button" onClick={() => profile.refetch()}>
          Try again
        </button>
      </div>
    );
  const p = profile.data,
    balance = rewards.data?.wallet.coinAvailability;
  const info = [
    ['Username', `@${p.username}`],
    ['Email address', p.email || 'Not added'],
    [
      'Phone number',
      p.phone ? `${p.phone}${p.phoneVerified ? ' · Verified' : ' · Not verified'}` : 'Not added',
    ],
    ['Member since', memberDate(p.createdAt)],
    ['Last sign-in', p.lastLoginAt ? new Date(p.lastLoginAt).toLocaleString() : 'Not available'],
    ['Account status', label(p.status)],
    ['Account type', p.role === 'USER' ? 'Member' : label(p.role)],
    ['Account verification', p.isVerified ? 'Verified' : 'Not verified'],
    [
      'Identity verification',
      p.kycVerification
        ? `${label(p.kycVerification.status)} · Tier ${p.kycVerification.verifiedTier}`
        : 'Not submitted',
    ],
    ['Payment country', p.payoutCountry?.name || 'Not configured'],
    ['Wallet currency', 'Ethiopian Birr (ETB)'],
    [
      'Sign-in methods',
      p.signInMethods.length ? p.signInMethods.map(label).join(', ') : 'Password',
    ],
  ];
  return (
    <div className="salem-lounge member-account">
      <header className="member-heading">
        <div>
          <span className="salem-eyebrow">YOUR ACCOUNT</span>
          <h1>My profile</h1>
          <p>Your details, account activity, and security.</p>
        </div>
        <Link className="salem-button secondary" to="/rewards">
          My rewards <ArrowUpRight size={16} />
        </Link>
      </header>
      <section className="member-profile-hero">
        <div className="member-avatar">
          {p.avatarUrl ? (
            <img src={p.avatarUrl} alt="" />
          ) : (
            <span>{(p.displayName || p.username).slice(0, 1).toUpperCase()}</span>
          )}
        </div>
        <div>
          <span className="member-pill active">{label(p.status)} member</span>
          <h2>{p.displayName || p.username}</h2>
          <p>@{p.username}</p>
          {p.bio && <p className="member-bio">{p.bio}</p>}
        </div>
        <button
          className="salem-button secondary"
          onClick={() => {
            setDisplayName(p.displayName || p.username);
            setBio(p.bio || '');
            setEditing(true);
            setNotice('');
          }}
        >
          <Pencil size={15} aria-hidden="true" />
          Edit profile
        </button>
      </section>
      {notice && (
        <p role="status" className="member-feedback">
          {notice}
        </p>
      )}
      {editing && (
        <form
          className="member-panel member-edit"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <h2>Edit your profile</h2>
          <label>
            Display name
            <input
              autoFocus
              required
              maxLength={100}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label>
            About you
            <textarea
              rows={3}
              maxLength={500}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
            />
          </label>
          <small>{bio.length}/500 characters</small>
          <div className="member-actions">
            <button className="salem-button" disabled={save.isPending || !displayName.trim()}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
            <button
              className="salem-button secondary"
              type="button"
              disabled={save.isPending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <div className="member-profile-grid">
        <section className="member-panel">
          <div className="member-section-title">
            <h2>
              <UserRound size={19} aria-hidden="true" />
              Account details
            </h2>
            <span className="member-muted">Visible only to you</span>
          </div>
          <dl className="member-details">
            {info.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="member-id">
            <span>Member ID</span>
            <code>{p.id}</code>
          </div>
        </section>
        <aside className="member-profile-aside">
          <section className="member-panel">
            <h2>Your Birr balances</h2>
            {rewards.isError ? (
              <div role="alert">
                <p>Balances are unavailable.</p>
                <button className="salem-button secondary" onClick={() => rewards.refetch()}>
                  Retry balances
                </button>
              </div>
            ) : rewards.isPending ? (
              <p role="status">Loading balances…</p>
            ) : (
              <>
                <div className="member-mini-balance">
                  <span>Available cash</span>
                  <strong>{formatEtb(balance?.spendable)}</strong>
                </div>
                <div className="member-mini-balance">
                  <span>Bonus · bets only</span>
                  <strong>{formatEtb(balance?.betOnly)}</strong>
                </div>
                <div className="member-mini-balance">
                  <span>Held for review</span>
                  <strong>{formatEtb(balance?.pendingReview)}</strong>
                </div>
                <p className="member-muted">
                  Bonus principal cannot be withdrawn. Only eligible net winnings become cash.
                  Practice ETB is separate.
                </p>
              </>
            )}
            <Link className="member-text-link" to="/wallet/deposit">
              Payment options <ArrowUpRight size={15} />
            </Link>
          </section>
          <section className="member-panel">
            <h2>Invitations</h2>
            <p className="member-muted">Track your friends and earned referral Birr.</p>
            <Link className="salem-button secondary" to="/rewards">
              Open rewards <ArrowUpRight size={15} />
            </Link>
          </section>
        </aside>
      </div>
      <section className="member-panel member-security">
        <h2>
          <ShieldCheck size={20} aria-hidden="true" />
          Security & access
        </h2>
        <p className="member-muted">Protect sensitive account actions with an authenticator app.</p>
        <AuthenticatorSetup key={userId} />
      </section>
      <ChangePassword />
      <footer className="member-profile-footer">
        <div>
          <h2>Need help with your details?</h2>
          <p>Contact support for changes to your sign-in or verification information.</p>
          <Link className="member-text-link" to="/support">
            Contact support <ArrowUpRight size={15} />
          </Link>
        </div>
        <button className="salem-button secondary" onClick={() => void logout()}>
          <LogOut size={16} aria-hidden="true" />
          Sign out
        </button>
      </footer>
    </div>
  );
}
