import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { passwordSchema } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { getErrorMessage, getErrorStatus } from '@/lib/error-message';
import { useAuth } from '@/providers/auth-provider';
import { PasswordInput } from '@/components/member/password-input';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function ChangePassword() {
  const { t: translateUi } = useInterfaceLanguage();

  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const active = useRef(false);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [currentPassword, setCurrent] = useState(''),
    [newPassword, setNew] = useState(''),
    [confirm, setConfirm] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (active.current) return;
    if (newPassword !== confirm) {
      setMessage('The new passwords must match.');
      return;
    }
    if (
      !passwordSchema.safeParse(newPassword).success ||
      new TextEncoder().encode(newPassword).length > 72
    ) {
      setMessage(
        'Use 8 or more characters with uppercase, lowercase, a number and a symbol. Maximum 72 UTF-8 bytes.'
      );
      return;
    }
    active.current = true;
    setBusy(true);
    setMessage('');
    const body = { currentPassword, newPassword };
    setCurrent('');
    setNew('');
    setConfirm('');
    try {
      unwrapData(
        await boundedRequest((signal) =>
          api.post('/auth/change-password', body, undefined, { signal })
        )
      );
      await logout();
      const path = location.pathname.startsWith('/admin/')
        ? '/admin/login'
        : location.pathname.startsWith('/agent/')
          ? '/agent/login'
          : '/login';
      navigate(path, { replace: true, state: { passwordChanged: true } });
    } catch (error) {
      const code = getErrorStatus(error);
      setMessage(
        code && code >= 400 && code < 500
          ? getErrorMessage(error, 'Your password could not be changed.')
          : 'The change could not be confirmed. Try signing in with your new password before submitting again.'
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="member-panel">
      <h2>{translateUi('Password')}</h2>
      <p className="member-muted">
        {translateUi(
          'Change your password using your current password. You will sign in again afterward, and other sessions will be signed out.'
        )}
      </p>
      {!open ? (
        <button className="salem-button secondary" onClick={() => setOpen(true)}>
          {translateUi('Change password')}
        </button>
      ) : (
        <form className="member-edit" onSubmit={submit}>
          <label htmlFor="account-current-password">{translateUi('Current password')}</label>
          <PasswordInput
            id="account-current-password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={busy}
            required
          />
          <label htmlFor="account-new-password">{translateUi('New password')}</label>
          <PasswordInput
            id="account-new-password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            disabled={busy}
            required
          />
          <label htmlFor="account-confirm-password">{translateUi('Confirm new password')}</label>
          <PasswordInput
            id="account-confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            required
          />
          <p className="member-muted">
            {translateUi(
              'Use at least 8 characters, with uppercase, lowercase, a number and a symbol.'
            )}
          </p>
          {message && <p role="alert">{translateUi(message)}</p>}
          <button className="salem-button" disabled={busy}>
            {busy ? translateUi('Changing password…') : translateUi('Save new password')}
          </button>
          <button
            type="button"
            className="salem-button secondary"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setCurrent('');
              setNew('');
              setConfirm('');
              setMessage('');
            }}
          >
            {translateUi('Cancel')}
          </button>
        </form>
      )}
    </section>
  );
}
