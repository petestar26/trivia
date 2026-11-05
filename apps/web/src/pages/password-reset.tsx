import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { passwordSchema } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { requestStatus } from '@/lib/request-error';
import { clearPasswordResetLink, readPasswordResetLink } from '@/lib/password-reset-link';
import { PasswordInput } from '@/components/member/password-input';
import { Button } from '@/components/ui/button';

export function PasswordResetPage() {
  const [token, setToken] = useState(readPasswordResetLink);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    // Fragments never enter HTTP/referrer logs. Remove the credential from the
    // address bar/history immediately; retain it only in this tab until expiry.
    if (window.location.hash)
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search
      );
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('The passwords must match.');
      return;
    }
    if (
      !passwordSchema.safeParse(password).success ||
      new TextEncoder().encode(password).length > 72
    ) {
      setError(
        'Use 8 or more characters with uppercase, lowercase, a number and a symbol. Maximum 72 UTF-8 bytes.'
      );
      return;
    }
    setBusy(true);
    try {
      unwrapData(await api.post('/auth/password-reset', { token, password }));
      clearPasswordResetLink();
      setDone(true);
      setToken('');
      setPassword('');
      setConfirm('');
    } catch (err) {
      if (requestStatus(err) === 401) clearPasswordResetLink();
      setError(
        getErrorMessage(
          err,
          'The password change could not be confirmed. Try signing in before requesting another link.'
        )
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center px-4">
      <section className="w-full max-w-md rounded-xl border bg-white dark:bg-gray-800 p-7 shadow-sm">
        <p className="text-sm font-semibold text-primary-600 mb-2">SALEM BET · ACCOUNT RECOVERY</p>
        <h1 className="text-2xl font-bold mb-3">
          {done ? 'Your password is ready' : 'Set a new password'}
        </h1>
        {done ? (
          <div role="status">
            <p className="mb-5">Your password was updated. Sign in again with your new password.</p>
            <Link to="/admin/login" className="font-semibold text-primary-600">
              Continue to administrator sign in
            </Link>
          </div>
        ) : !token ? (
          <p role="alert">
            Open your current recovery link to set a new password. Links expire after 15 minutes and
            can only be used once.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Choose a private password for your account. This link works once and expires after 15
              minutes.
            </p>
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            <div>
              <label htmlFor="new-password" className="block text-sm font-medium mb-2">
                New password
              </label>
              <PasswordInput
                id="new-password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                required
              />
              <p className="mt-2 text-xs text-gray-500">
                At least 8 characters, with uppercase, lowercase, a number and a symbol.
              </p>
            </div>
            <div>
              <label htmlFor="confirm-password" className="block text-sm font-medium mb-2">
                Confirm new password
              </label>
              <PasswordInput
                id="confirm-password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Updating password…' : 'Save new password'}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
