import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  NUMBER_BANDS,
  NUMBER_TIMED_RULES_ID,
  numberScore,
  parseNumberTimedEntry,
  type NumberTimedEntry,
  type NumberTimedReceipt,
  type NumberTimedSnapshot,
} from '@socialplay/shared';
import { api, newIdempotencyKey, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { GameArena } from '@/components/games/game-arena';
import { wholeNumberRangeError } from '@/components/casino/whole-number-input';
import './number-challenge.css';

const endpoint = '/games/number-challenge-practice';
export const numberPendingKey = (id: string) => `playqube:number-practice:v2:${id}`;
function readPending(id: string): { entry: NumberTimedEntry | null; error: string } {
  try {
    const raw = sessionStorage.getItem(numberPendingKey(id));
    return { entry: raw ? parseNumberTimedEntry(JSON.parse(raw)) : null, error: '' };
  } catch {
    return {
      entry: null,
      error:
        'Your saved guess cannot be read. Allow site storage or return using the browser where you started it.',
    };
  }
}
function validReceipt(receipt: NumberTimedReceipt, entry: NumberTimedEntry) {
  if (
    receipt.guess !== entry.guess ||
    receipt.roundId !== entry.roundId ||
    typeof receipt.id !== 'string' ||
    !Number.isFinite(Date.parse(receipt.createdAt))
  )
    throw Error('Unconfirmed receipt');
  if (receipt.target === null) {
    if (receipt.away !== null || receipt.score !== null) throw Error('Unconfirmed score');
  } else {
    const score = numberScore(receipt.guess, receipt.target);
    if (receipt.away !== score.away || receipt.score !== score.score)
      throw Error('Unconfirmed score');
  }
  return receipt;
}
function conflict(error: unknown) {
  try {
    if (!(error instanceof Error)) return false;
    const e = JSON.parse(error.message);
    return (
      e.status === 409 &&
      [
        'This round is closed. Wait for the next round.',
        'You already placed a guess in this round.',
      ].includes(e.message)
    );
  } catch {
    return false;
  }
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
  const [pending, setPending] = useState<NumberTimedEntry | null>(saved.entry);
  const [guess, setGuess] = useState(String(saved.entry?.guess ?? 50));
  const [error, setError] = useState(saved.error);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NumberTimedReceipt | null>(null);
  const [clock, setClock] = useState(() => performance.now());
  const anchor = useRef({ received: -Infinity, server: NaN });
  useEffect(() => {
    const timer = setInterval(() => setClock(performance.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const [reduced, setReduced] = useState(false);
  const locked = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const query = useQuery<NumberTimedSnapshot>({
    queryKey: ['number-practice', userId],
    retry: false,
    refetchInterval: 2000,
    queryFn: ({ signal }) =>
      boundedRequest(
        (s) =>
          api.get<NumberTimedSnapshot>(endpoint, undefined, { signal: s }).then((r) => {
            const data = unwrapData(r, 'Number practice');
            anchor.current = { received: performance.now(), server: Date.parse(data.serverNow) };
            return data;
          }),
        signal
      ),
  });
  const inputError = wholeNumberRangeError(guess, 1, 100, 'Your number');
  const selected = Number(guess),
    round = query.data?.round;
  const elapsed = Math.max(0, clock - anchor.current.received);
  const now = anchor.current.server + elapsed;
  const fresh = elapsed < 8000 && Number.isFinite(now);
  const open = !!round && now >= Date.parse(round.opensAt) && now < Date.parse(round.closesAt);
  const current = !!round && now < Date.parse(round.endsAt);
  const accepted = query.data?.receipt ?? (result?.roundId === round?.id ? result : null);
  const ready =
    query.data?.rulesId === NUMBER_TIMED_RULES_ID && !query.isError && !saved.error && fresh;
  const canPlace = ready && open && !accepted;
  const controlsLocked = busy || !!pending || !canPlace;
  const target = current ? round?.target : null;
  const display = accepted?.target !== null && accepted?.target !== undefined ? accepted : null;
  const seconds =
    round && current
      ? Math.max(0, Math.ceil((Date.parse(open ? round.closesAt : round.endsAt) - now) / 1000))
      : 0;
  const clockLabel =
    !ready || !current ? 'Syncing round…' : open ? 'Guesses close in' : 'Next round in';
  const rounds = result
    ? [
        query.data?.history?.find((r) => r.id === result.id) ?? result,
        ...(query.data?.history ?? []).filter((r) => r.id !== result.id),
      ].slice(0, 20)
    : (query.data?.history ?? []);
  async function submit() {
    if (locked.current || !ready || (!pending && (!canPlace || inputError))) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const entry = pending ?? {
      requestId: newIdempotencyKey(),
      roundId: round!.id,
      guess: selected,
      rulesId: NUMBER_TIMED_RULES_ID,
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
          api.post<{ receipt: NumberTimedReceipt; isReplay: boolean }>(
            `${endpoint}/guesses`,
            entry,
            undefined,
            { signal }
          )
        ),
        'Number result'
      );
      const confirmed = validReceipt(data.receipt, entry);
      if (!alive.current) return;
      setResult(confirmed);

      setGuess(String(entry.guess));
      sessionStorage.removeItem(numberPendingKey(userId));
      setPending(null);
      void client.invalidateQueries({ queryKey: ['number-practice', userId] });
    } catch (e) {
      if (alive.current && conflict(e)) {
        sessionStorage.removeItem(numberPendingKey(userId));
        setPending(null);
        setError(
          'This guess was not accepted: the round closed or you already entered. Check your results and wait for the next round.'
        );
        void client.invalidateQueries({ queryKey: ['number-practice', userId] });
      } else if (alive.current)
        setError(
          'Your guess has not been confirmed. Retry saved guess to check the same result; your original request will not be replaced.'
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
          <p>One-minute rounds · 30 seconds to choose · one shared target.</p>
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
            <div className={`number-countdown ${open ? '' : 'number-countdown--closed'}`}>
              <span>{clockLabel}</span>
              <strong aria-label="Round countdown">
                {ready && current ? `00:${String(seconds).padStart(2, '0')}` : '—'}
              </strong>
              <div className="number-countdown-track" aria-hidden="true">
                <i style={{ width: `${(seconds / 30) * 100}%` }} />
              </div>
            </div>
            <p className="number-eyebrow">
              {target != null
                ? 'SHARED ROUND RESULT'
                : open
                  ? 'ENTRY WINDOW OPEN'
                  : 'ENTRIES CLOSED'}
            </p>
            <div key={round?.id ?? 'waiting'} className="number-ball" aria-hidden="true">
              <div className="number-orbit" aria-hidden="true" />
              <span>{target != null ? String(target).padStart(2, '0') : '?'}</span>
            </div>
            <div className="number-result" role="status" aria-live="polite">
              {busy ? (
                <>
                  <h2>Confirming your guess…</h2>
                  <p>Your guess is saved while we confirm it.</p>
                </>
              ) : display ? (
                <>
                  <h2>{display.away === 0 ? 'Exact match!' : `${display.away} away`}</h2>
                  <p>
                    Your number <b>{display.guess}</b> · Target <b>{display.target}</b>
                  </p>
                  <strong>{display.score} practice score</strong>
                </>
              ) : accepted ? (
                <>
                  <h2>Guess accepted: {accepted.guess}</h2>
                  <p>
                    {open
                      ? 'Your number is locked. Result after entries close.'
                      : 'Waiting for the confirmed result…'}
                  </p>
                </>
              ) : target != null ? (
                <>
                  <h2>Target: {target}</h2>
                  <p>You did not enter this round. Choose a number in the next round.</p>
                </>
              ) : (
                <>
                  <h2>
                    {open
                      ? 'Place your guess'
                      : current
                        ? 'Waiting for the result'
                        : 'Syncing the next round'}
                  </h2>
                  <p>One guess per round. The server confirms the closing time.</p>
                </>
              )}
            </div>
            <p className="number-stage-note">
              Independent random targets · previous results cannot predict the next number
            </p>
          </div>
        </GameArena>
        <section className="number-panel" aria-labelledby="number-pick-title">
          <p className="number-eyebrow">
            {clockLabel} {ready && current ? `00:${String(seconds).padStart(2, '0')}` : ''}
          </p>
          <h2 id="number-pick-title">Choose your number</h2>
          <label htmlFor="number-guess">Number from 1 to 100</label>
          <div className="number-stepper">
            <button
              aria-label="Decrease number"
              disabled={controlsLocked || !Number.isInteger(selected) || selected <= 1}
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
              disabled={controlsLocked}
              onChange={(e) => setGuess(e.target.value)}
              aria-invalid={!!inputError}
              aria-describedby="number-input-help"
            />
            <button
              aria-label="Increase number"
              disabled={controlsLocked || !Number.isInteger(selected) || selected >= 100}
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
            disabled={controlsLocked}
            onChange={(e) => setGuess(e.target.value)}
          />
          <div className="number-presets">
            {[1, 25, 50, 75, 100].map((n) => (
              <button
                key={n}
                aria-pressed={selected === n}
                disabled={controlsLocked}
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
          {query.data && query.data.rulesId !== NUMBER_TIMED_RULES_ID && (
            <p role="alert">The game rules have changed. Reload the app before playing.</p>
          )}
          {pending && (
            <p className="number-notice">
              Saved guess: <b>{pending.guess}</b>. Check this saved request before choosing another
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
            disabled={!ready || busy || (!pending && (!canPlace || !!inputError))}
            onClick={() => void submit()}
          >
            {busy
              ? 'Confirming…'
              : pending
                ? 'Retry saved guess'
                : accepted
                  ? 'Guess placed'
                  : !open
                    ? 'Entries closed'
                    : 'Place guess'}
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
            Each round lasts one minute. During the first 30 seconds, choose an integer from 1 to
            100 and select Place guess. You can place one guess per round and cannot change it after
            acceptance. Entries close for the final 30 seconds, when everyone sees the same random
            target. A delayed connection may cause a guess to arrive too late; server time decides
            acceptance. Your score follows the distance bands above. An exact match has a 1 in 100
            chance. Numbers near the ends of the range have fewer nearby targets; proximity scores
            are not equally likely for every guess.
          </p>
          <p>
            The target is selected by the server’s cryptographic random generator after the entry
            window closes. If the server is delayed, results remain pending until confirmed. This is
            not a precommitted, independently verifiable draw. The animation only presents the saved
            result. Retrying a saved guess returns that same result. Scores are for this game only
            and have no cash value.
          </p>
          <p>Rules: {NUMBER_TIMED_RULES_ID}. Original PlayQube game, not affiliated with 1xBet.</p>
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
                      <b>{r.target ?? '—'}</b>
                    </td>
                    <td>
                      {r.away === null ? 'Pending' : r.away === 0 ? 'Exact' : `${r.away} away`}
                    </td>
                    <td>{r.score ?? '—'}</td>
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
