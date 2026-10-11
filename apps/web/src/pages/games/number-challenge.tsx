import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  NUMBER_BANDS,
  NUMBER_RULES_ID,
  numberScore,
  parseNumberEntry,
  type NumberEntry,
  type NumberRound,
  type NumberSnapshot,
} from '@socialplay/shared';
import { api, newIdempotencyKey, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { GameArena } from '@/components/games/game-arena';
import { wholeNumberRangeError } from '@/components/casino/whole-number-input';
import './number-challenge.css';

const endpoint = '/games/number-challenge-practice';
export const numberPendingKey = (id: string) => `playqube:number-practice:v1:${id}`;
function readPending(id: string): { entry: NumberEntry | null; error: string } {
  try {
    const raw = sessionStorage.getItem(numberPendingKey(id));
    return { entry: raw ? parseNumberEntry(JSON.parse(raw)) : null, error: '' };
  } catch {
    return {
      entry: null,
      error:
        'Your saved guess cannot be read. Allow site storage or return using the browser where you started it.',
    };
  }
}
function validRound(round: NumberRound, entry: NumberEntry) {
  const { away, score } = numberScore(round.guess, round.target);
  if (
    round.guess !== entry.guess ||
    round.rulesId !== entry.rulesId ||
    round.away !== away ||
    round.score !== score ||
    typeof round.id !== 'string' ||
    !Number.isFinite(Date.parse(round.createdAt))
  )
    throw new Error('The result could not be confirmed. Retry your saved guess.');
  return round;
}
export function NumberChallengePage() {
  const { user } = useAuth();
  return user ? (
    <NumberPractice key={user.id} userId={user.id} />
  ) : (
    <p>Sign in to play Number Challenge.</p>
  );
}
function NumberPractice({ userId }: { userId: string }) {
  const client = useQueryClient();
  const [saved] = useState(() => readPending(userId));
  const [pending, setPending] = useState<NumberEntry | null>(saved.entry);
  const [guess, setGuess] = useState(String(saved.entry?.guess ?? 50));
  const [error, setError] = useState(saved.error);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NumberRound | null>(null);
  const [replay, setReplay] = useState(false);
  const [reduced, setReduced] = useState(false);
  const locked = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const query = useQuery<NumberSnapshot>({
    queryKey: ['number-practice', userId],
    retry: false,
    queryFn: ({ signal }) =>
      boundedRequest(
        (s) =>
          api
            .get<NumberSnapshot>(endpoint, undefined, { signal: s })
            .then((r) => unwrapData(r, 'Number practice')),
        signal
      ),
  });
  const inputError = wholeNumberRangeError(guess, 1, 100, 'Your number');
  const selected = Number(guess),
    display = result ?? query.data?.rounds[0] ?? null;
  const ready = query.data?.rulesId === NUMBER_RULES_ID && !query.isError && !saved.error;
  const rounds = result
    ? [result, ...(query.data?.rounds ?? []).filter((r) => r.id !== result.id)].slice(0, 20)
    : (query.data?.rounds ?? []);
  async function submit() {
    if (locked.current || !ready || (!pending && inputError)) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const entry = pending ?? {
      requestId: newIdempotencyKey(),
      guess: selected,
      rulesId: NUMBER_RULES_ID,
    };
    try {
      // Read-back before sending. An unresolved request is never silently replaced.
      const value = JSON.stringify(entry);
      sessionStorage.setItem(numberPendingKey(userId), value);
      if (sessionStorage.getItem(numberPendingKey(userId)) !== value)
        throw new Error('Storage unavailable');
      setPending(entry);
    } catch {
      setError('Nothing was sent. Allow this site to store your guess safely, then retry.');
      setBusy(false);
      locked.current = false;
      return;
    }
    try {
      const data = unwrapData(
        await boundedRequest((signal) =>
          api.post<{ round: NumberRound; isReplay: boolean }>(
            `${endpoint}/guesses`,
            entry,
            undefined,
            { signal }
          )
        ),
        'Number result'
      );
      const confirmed = validRound(data.round, entry);
      if (!alive.current) return;
      setResult(confirmed);
      setReplay(data.isReplay);
      setGuess(String(entry.guess));
      sessionStorage.removeItem(numberPendingKey(userId));
      setPending(null);
      void client.invalidateQueries({ queryKey: ['number-practice', userId] });
    } catch {
      if (alive.current)
        setError(
          'Your guess has not been confirmed. Retry saved guess to check the same result; a new round will not be created.'
        );
    } finally {
      if (alive.current) {
        setBusy(false);
        locked.current = false;
      }
    }
  }
  return (
    <div className={`number-game ${reduced ? 'number-game--still' : ''}`}>
      <header className="number-header">
        <div>
          <Link to="/games">← All games</Link>
          <p className="number-eyebrow">PLAYQUBE ORIGINAL · FREE PRACTICE</p>
          <h1>
            Number <span>Challenge</span>
          </h1>
          <p>Pick your number. Reveal the target. See how close you get.</p>
        </div>
        <label className="number-motion">
          <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} />{' '}
          Reduced motion
        </label>
      </header>
      <div className="number-layout">
        <GameArena title="Number Challenge">
          <div className={`number-stage ${busy ? 'is-revealing' : ''}`}>
            <div className="number-stage-top">
              <span className="number-wordmark">
                N<span>º</span> / CHALLENGE
              </span>
              <span className="number-badge">1 — 100</span>
            </div>
            <p className="number-eyebrow">
              {busy
                ? 'CONFIRMING YOUR GUESS'
                : display
                  ? 'LATEST CONFIRMED TARGET'
                  : 'FIND YOUR NUMBER'}
            </p>
            <div
              key={busy ? 'pending' : (display?.id ?? 'waiting')}
              className="number-ball"
              aria-hidden="true"
            >
              <div className="number-orbit" aria-hidden="true" />
              <span>{busy ? '···' : display ? String(display.target).padStart(2, '0') : '?'}</span>
            </div>
            <div className="number-result" role="status" aria-live="polite">
              {busy ? (
                <>
                  <h2>Revealing…</h2>
                  <p>Your guess is saved while we confirm it.</p>
                </>
              ) : display ? (
                <>
                  <h2>{display.away === 0 ? 'Exact match!' : `${display.away} away`}</h2>
                  <p>
                    Your number <b>{display.guess}</b> · Target <b>{display.target}</b>
                  </p>
                  <strong>{display.score} practice score</strong>
                  {replay && <p>Recovered result · no new round</p>}
                </>
              ) : (
                <>
                  <h2>One number. Your choice.</h2>
                  <p>Choose a whole number from 1 to 100.</p>
                </>
              )}
            </div>
            <p className="number-stage-note">
              Independent random targets · previous results cannot predict the next number
            </p>
          </div>
        </GameArena>
        <section className="number-panel" aria-labelledby="number-pick-title">
          <p className="number-eyebrow">YOUR NEXT GUESS</p>
          <h2 id="number-pick-title">Choose your number</h2>
          <label htmlFor="number-guess">Number from 1 to 100</label>
          <div className="number-stepper">
            <button
              aria-label="Decrease number"
              disabled={busy || !!pending || !Number.isInteger(selected) || selected <= 1}
              onClick={() => setGuess(String(selected - 1))}
            >
              −
            </button>
            <input
              id="number-guess"
              type="number"
              inputMode="numeric"
              min="1"
              max="100"
              step="1"
              value={guess}
              disabled={busy || !!pending}
              onChange={(e) => setGuess(e.target.value)}
              aria-invalid={!!inputError}
              aria-describedby="number-input-help"
            />
            <button
              aria-label="Increase number"
              disabled={busy || !!pending || !Number.isInteger(selected) || selected >= 100}
              onClick={() => setGuess(String(selected + 1))}
            >
              +
            </button>
          </div>
          <p id="number-input-help">
            {inputError || 'Every target from 1 to 100 is equally likely.'}
          </p>
          <input
            aria-label="Choose number with slider"
            type="range"
            min="1"
            max="100"
            step="1"
            value={Number.isInteger(selected) ? Math.min(100, Math.max(1, selected)) : 50}
            disabled={busy || !!pending}
            onChange={(e) => setGuess(e.target.value)}
          />
          <div className="number-presets">
            {[1, 25, 50, 75, 100].map((n) => (
              <button
                key={n}
                aria-pressed={selected === n}
                disabled={busy || !!pending}
                onClick={() => setGuess(String(n))}
              >
                {n}
              </button>
            ))}
          </div>
          {query.isPending && <p role="status">Loading practice…</p>}
          {query.isError && (
            <div role="alert">
              <p>Practice is unavailable. Check your connection or sign in again.</p>
              <button onClick={() => void query.refetch()}>Retry loading</button>
            </div>
          )}
          {query.data && query.data.rulesId !== NUMBER_RULES_ID && (
            <p role="alert">The game rules have changed. Reload the app before playing.</p>
          )}
          {pending && (
            <p className="number-notice">
              Saved guess: <b>{pending.guess}</b>. Confirm this result before choosing another
              number.
            </p>
          )}
          {error && (
            <p role="alert" className="number-notice">
              {error}
            </p>
          )}
          <button
            className="number-submit"
            disabled={!ready || busy || (!pending && !!inputError)}
            onClick={() => void submit()}
          >
            {busy ? 'Confirming…' : pending ? 'Retry saved guess' : 'Reveal number'}
          </button>
          <p className="number-free">
            Free to play · no stakes, Coins or cash prizes.
            <br />
            Practice scores cannot be spent or transferred.
          </p>
        </section>
      </div>
      <section className="number-panel number-scoring" aria-labelledby="number-scoring-title">
        <div>
          <p className="number-eyebrow">KNOW YOUR SCORE</p>
          <h2 id="number-scoring-title">Closer is better</h2>
        </div>
        <div className="number-bands">
          {NUMBER_BANDS.map((b) => (
            <div key={b.distance}>
              <b>{b.score}</b>
              <span>{b.label}</span>
            </div>
          ))}
        </div>
        <details>
          <summary>How to play & fairness</summary>
          <p>
            Choose an integer from 1 to 100 and select Reveal number. The server randomly selects an
            independent target from the same range. Your score follows the distance bands above. An
            exact match has a 1 in 100 chance. Numbers near the ends of the range have fewer nearby
            targets; proximity scores are not equally likely for every guess.
          </p>
          <p>
            The target is selected by the server’s cryptographic random generator after submission.
            This is not a precommitted, independently verifiable draw. The animation only presents
            the saved result. Retrying a saved guess returns that same result. Scores are for this
            game only and have no cash value.
          </p>
          <p>Rules: {NUMBER_RULES_ID}. Original PlayQube game, not affiliated with 1xBet.</p>
        </details>
      </section>
      <section className="number-panel" aria-labelledby="number-history-title">
        <p className="number-eyebrow">YOUR LAST 20 ROUNDS</p>
        <h2 id="number-history-title">Recent results</h2>
        {rounds.length ? (
          <div className="number-history">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Your number</th>
                  <th>Target</th>
                  <th>Distance</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <time dateTime={r.createdAt}>
                        {new Date(r.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </td>
                    <td>{r.guess}</td>
                    <td>
                      <b>{r.target}</b>
                    </td>
                    <td>{r.away === 0 ? 'Exact' : `${r.away} away`}</td>
                    <td>{r.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="number-empty">
            Your confirmed results will appear here after your first guess.
          </p>
        )}
      </section>
    </div>
  );
}
