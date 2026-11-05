import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Trophy } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { navigateToSportsbook, requestSportsLaunch } from '@/lib/sports-launch';
import './sports.css';

export function SportsLaunchPage() {
  const { user } = useAuth();
  return user ? <SportsLaunch key={user.id} /> : <p>Sign in to browse sports.</p>;
}

function SportsLaunch() {
  const request = useRef<Promise<string> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
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
  }, [attempt]);

  return (
    <section className="salem-sports sports-launch-page" aria-labelledby="sports-launch-title">
      <Link to="/sports" className="sports-return">
        <ArrowLeft size={16} /> Back to sports
      </Link>
      <Trophy size={32} aria-hidden="true" />
      <p className="sports-eyebrow">SALEM BET SPORTS</p>
      <h1 id="sports-launch-title">
        {failed ? 'Let’s try that again.' : 'Opening the sportsbook…'}
      </h1>
      {failed ? (
        <>
          <p role="alert">Sports could not be opened. Please try again.</p>
          <button
            className="sports-open"
            onClick={() => {
              request.current = null;
              setFailed(false);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        </>
      ) : (
        <p role="status">
          Connecting to Nocturn Sport. Your Salem Bet wallet stays in the original tab.
        </p>
      )}
    </section>
  );
}
