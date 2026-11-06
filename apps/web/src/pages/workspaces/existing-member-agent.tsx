import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { getErrorMessage, getErrorStatus } from '@/lib/error-message';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function ExistingMemberAgentForm({
  countries,
  countriesUnavailable,
}: {
  countries: Array<{ id: string; name: string; isActive: boolean }>;
  countriesUnavailable: boolean;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  const cache = useQueryClient();
  const active = useRef(false);
  const [email, setEmail] = useState(''),
    [displayName, setDisplayName] = useState('');
  const [countryId, setCountryId] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [result, setResult] = useState<{ email: string; username: string } | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (active.current || !confirmed) return;
    active.current = true;
    setBusy(true);
    setMessage('');
    setResult(null);
    try {
      const value = unwrapData(
        await boundedRequest((signal) =>
          api.post<{ email: string; username: string }>(
            '/agents/admin/accounts/existing',
            { email: email.trim(), displayName: displayName.trim(), countryId },
            undefined,
            { signal }
          )
        )
      );
      setResult(value);
      setConfirmed(false);
      for (const queryKey of [
        ['admin-agents'],
        ['admin-accounts'],
        ['admin-overview'],
        ['payments'],
      ])
        void cache.invalidateQueries({ queryKey });
    } catch (error) {
      const status = getErrorStatus(error);
      setMessage(
        status && status >= 400 && status < 500
          ? getErrorMessage(error, 'Check the member and country details.')
          : 'Approval could not be confirmed. Check Agents before trying again; the member may already have agent access.'
      );
      setConfirmed(false);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="workspace-panel">
      <h2>{translateUi('Approve an existing member')}</h2>
      <p>
        {translateUi(
          'The member keeps their current password, wallet and account history. This grants agent access; receiving accounts and funding are configured separately.'
        )}
      </p>
      {result ? (
        <div role="status">
          <h3>{translateUi('Agent access approved')}</h3>
          <p>
            {result.username} · {result.email}
          </p>
          <p>{translateUi('Use the member’s existing password to sign in.')}</p>
          <Link to="/agent/login">{translateUi('Agent sign in')}</Link>
          <Link to="/admin/agents">{translateUi('View agents')}</Link>
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setEmail('');
              setDisplayName('');
            }}
          >
            {translateUi('Approve another member')}
          </button>
        </div>
      ) : (
        <form className="workspace-account-form" onSubmit={submit}>
          <label>
            {translateUi('Member email')}
            <input
              type="email"
              required
              maxLength={255}
              value={email}
              disabled={busy}
              onChange={(e) => {
                setEmail(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            {translateUi('Agent display name')}
            <input
              required
              maxLength={100}
              value={displayName}
              disabled={busy}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            {translateUi('Agent country')}
            <select
              required
              value={countryId}
              disabled={busy || countriesUnavailable}
              onChange={(e) => {
                setCountryId(e.target.value);
                setConfirmed(false);
              }}
            >
              <option value="">{translateUi('Choose an active country')}</option>
              {countries
                .filter((c) => c.isActive)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="workspace-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {translateUi('I authorize agent access for this member.')}
          </label>
          {message && (
            <p role="alert">
              {translateUi(message)} <Link to="/admin/agents">{translateUi('Check agents')}</Link>
            </p>
          )}
          <button
            disabled={
              busy ||
              !confirmed ||
              !countryId ||
              !email.trim() ||
              !displayName.trim() ||
              countriesUnavailable
            }
          >
            {busy ? translateUi('Approving member…') : translateUi('Approve agent access')}
          </button>
        </form>
      )}
    </section>
  );
}
