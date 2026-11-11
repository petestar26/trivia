import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Trophy } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { navigateToSportsbook, requestSportsLaunch } from '@/lib/sports-launch';
import { consumeLaunchIntent } from '@/lib/launch-intent';
import './sports.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function SportsLaunchPage() {
  const { t: translateUi } = useInterfaceLanguage();

  const { user } = useAuth();
  return user ? (
    <SportsLaunch key={user.id} userId={user.id} />
  ) : (
    <p>{translateUi('Sign in to browse sports.')}</p>
  );
}

function SportsLaunch({ userId }: { userId: string }) {
  const { t: translateUi } = useInterfaceLanguage();

  const [params, setParams] = useSearchParams();
  // null: not decided yet; false: no fresh click intent, so wait for one here.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const checked = useRef(false);
  useEffect(() => {
    // Consume the one-time intent exactly once (StrictMode replays effects, not refs),
    // then drop it from the address so reload or Back cannot reuse it.
    if (checked.current) return;
    checked.current = true;
    setAllowed(consumeLaunchIntent('sports', userId, params.get('intent')));
    if (params.has('intent'))
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('intent');
          return next;
        },
        { replace: true }
      );
  }, [params, setParams, userId]);

  const request = useRef<Promise<string> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!allowed) return;
    let active = true;
    // Reuse the request during StrictMode's effect replay; create no duplicate session.
    request.current ??= requestSportsLaunch();
    void request.current.then(
      (url) => {
        if (active) navigateToSportsbook(url);
      },
      () => {
        if (active) setFailed(true);
      }
    );
    return () => {
      active = false;
    };
  }, [attempt, allowed]);

  return (
    <section className="salem-sports sports-launch-page" aria-labelledby="sports-launch-title">
      <Link to="/sports" className="sports-return">
        <ArrowLeft size={16} />
        {' ' + translateUi('Back to sports')}
      </Link>
      <Trophy size={32} aria-hidden="true" />
      <p className="sports-eyebrow">{translateUi('SALEM BET SPORTS')}</p>
      <h1 id="sports-launch-title">
        {allowed === false
          ? translateUi('Browse sports')
          : failed
            ? translateUi('Let’s try that again.')
            : translateUi('Opening the sportsbook…')}
      </h1>
      {allowed === false ? (
        <>
          <p>{translateUi('The sportsbook opens only when you choose it.')}</p>
          <button className="sports-open" onClick={() => setAllowed(true)}>
            {translateUi('Browse sports')}
          </button>
        </>
      ) : failed ? (
        <>
          <p role="alert">{translateUi('Sports could not be opened. Please try again.')}</p>
          <button
            className="sports-open"
            onClick={() => {
              request.current = null;
              setFailed(false);
              setAttempt((value) => value + 1);
            }}
          >
            {translateUi('Try again')}
          </button>
        </>
      ) : (
        allowed && (
          <p role="status">
            {translateUi(
              'Connecting to Nocturn Sport. Your Salem Bet wallet stays in the original tab.'
            )}
          </p>
        )
      )}
    </section>
  );
}
