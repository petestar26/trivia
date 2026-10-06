import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { walletError } from '@/hooks/use-wallet-action';

type Enrollment = { secret: string; challenge: string; expiresAt: string };
type Factors = { factors: { type: string; status: string }[] };
export function AuthenticatorSetup() {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const factors = useQuery({
    queryKey: ['security-factors'],
    queryFn: ({ signal }) =>
      boundedRequest(
        (s) => api.get<Factors>('/security/factors', undefined, { signal: s }).then(unwrapData),
        signal
      ),
    retry: false,
  });
  const enabled = factors.data?.factors.some((f) => f.type === 'TOTP' && f.status === 'ACTIVE');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enrollment) return;
    const timer = setTimeout(
      () => {
        setEnrollment(null);
        setCode('');
        setMessage('Setup expired. Start again to get a new setup key.');
      },
      Math.max(0, Date.parse(enrollment.expiresAt) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [enrollment]);
  async function run(activate: boolean) {
    if (inFlight.current || (activate && (!enrollment || !/^\d{6}$/.test(code)))) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    const submitted = code;
    setCode('');
    try {
      if (activate) {
        unwrapData(
          await boundedRequest((signal) =>
            api.post(
              '/security/totp/activate',
              { challenge: enrollment!.challenge, code: submitted },
              undefined,
              { signal }
            )
          )
        );
        if (!mounted.current) return;
        setEnrollment(null);
        setMessage('Authenticator enabled. Use its current code when confirming a withdrawal.');
      } else {
        setEnrollment(null);
        const data = unwrapData(
          await boundedRequest((signal) =>
            api.post<Enrollment>('/security/totp/start', {}, undefined, { signal })
          )
        );
        if (!mounted.current) return;
        if (
          !data.secret ||
          !data.challenge ||
          !Number.isFinite(Date.parse(data.expiresAt)) ||
          Date.parse(data.expiresAt) <= Date.now()
        )
          throw new Error('Setup could not be verified. Start again.');
        setEnrollment(data);
      }
    } catch (error) {
      if (!mounted.current) return;
      setMessage(walletError(error));
    } finally {
      if (mounted.current) {
        const result = await factors.refetch();
        if (mounted.current) {
          if (result.data?.factors.some((f) => f.status === 'ACTIVE')) setEnrollment(null);
          setBusy(false);
        }
      }
      inFlight.current = false;
    }
  }
  return (
    <section
      id="security"
      className="space-y-4 rounded-xl border p-5"
      aria-labelledby="authenticator-title"
    >
      <h2 id="authenticator-title" className="text-xl font-semibold">
        Authenticator security
      </h2>
      <p>Use a time-based authenticator app to confirm sensitive actions, including withdrawals.</p>
      {factors.isPending ? (
        <p role="status">Checking authenticator…</p>
      ) : factors.isError ? (
        <p role="alert">
          Could not check security settings.{' '}
          <button onClick={() => factors.refetch()}>Retry</button>
        </p>
      ) : enabled ? (
        <p role="status">Authenticator enabled</p>
      ) : (
        <>
          {!enrollment ? (
            <button disabled={busy || factors.isFetching} onClick={() => run(false)}>
              {busy ? 'Starting…' : 'Set up authenticator'}
            </button>
          ) : (
            <>
              <p>
                In your authenticator app, add an account with a setup key. Choose time-based, name
                it PlayQube, and enter this key. Keep it private.
              </p>
              <label className="block">
                Setup key
                <input
                  className="block w-full rounded border p-2 font-mono"
                  readOnly
                  value={enrollment.secret}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <p>Expires at {new Date(enrollment.expiresAt).toLocaleTimeString()}.</p>
              <label className="block">
                Six-digit authenticator code
                <input
                  className="block rounded border p-2"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  disabled={busy}
                />
              </label>
              <button disabled={busy || !/^\d{6}$/.test(code)} onClick={() => run(true)}>
                Confirm authenticator
              </button>{' '}
              <button
                disabled={busy}
                onClick={() => {
                  setEnrollment(null);
                  setCode('');
                }}
              >
                Cancel setup
              </button>
            </>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
