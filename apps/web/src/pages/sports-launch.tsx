import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Trophy } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { navigateToSportsbook, requestSportsLaunch } from '@/lib/sports-launch';
import { sessionRevision } from '@/lib/session';
import { consumeLaunchIntent } from '@/lib/launch-intent';
import './sports.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function SportsLaunchPage() {
  const { t: translateUi } = useInterfaceLanguage();

  const { user } = useAuth();
  const location = useLocation();
  const [restoration, setRestoration] = useState(0);
  useEffect(() => {
    // A restored document keeps React mounted. Give it a fresh click-only
    // session; never revive the previous launch promise or arrival permission.
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setRestoration((value) => value + 1);
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);
  return user ? (
    <SportsLaunch
      key={`${user.id}:${sessionRevision()}:${location.key}:${restoration}`}
      userId={user.id}
      allowArrival={restoration === 0}
    />
  ) : (
    <p>{translateUi('Sign in to browse sports.')}</p>
  );
}

function SportsLaunch({ userId, allowArrival }: { userId: string; allowArrival: boolean }) {
  const { t: translateUi } = useInterfaceLanguage();

  const [params] = useSearchParams();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const revision = useRef(sessionRevision());
  const arrival = useRef<Promise<boolean> | null>(null);
  useEffect(() => {
    let active = true;
    const leave = () => {
      active = false;
    };
    window.addEventListener('pagehide', leave);
    arrival.current ??= allowArrival
      ? consumeLaunchIntent('sports', userId, params.get('intent'))
      : Promise.resolve(false);
    void arrival.current.then((value) => {
      if (active) setAllowed(value && revision.current === sessionRevision());
    });
    return () => {
      leave();
      window.removeEventListener('pagehide', leave);
    };
  }, [params, userId, allowArrival]);

  const request = useRef<Promise<string> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!allowed || revision.current !== sessionRevision()) return;
    let active = true;
    const leave = () => {
      active = false;
    };
    window.addEventListener('pagehide', leave);
    // Reuse the request during StrictMode's effect replay; create no duplicate session.
    request.current ??= requestSportsLaunch();
    void request.current.then(
      (url) => {
        if (active && revision.current === sessionRevision()) navigateToSportsbook(url);
      },
      () => {
        if (active) setFailed(true);
      }
    );
    return () => {
      leave();
      window.removeEventListener('pagehide', leave);
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
