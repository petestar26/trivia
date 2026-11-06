import { GameRoundSummary } from '@/components/games/game-round-summary';
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
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
  const { t: translateUi } = useInterfaceLanguage();

  const { user } = useAuth();
  return user ? (
    <NumberPractice key={user.id} userId={user.id} />
  ) : (
    <p>{translateUi('Sign in to play Number Challenge.')}</p>
  );
}
function NumberPractice({ userId }: { userId: string }) {
  const { t: translateUi } = useInterfaceLanguage();

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
  const shownGuess = accepted?.guess ?? pending?.guess ?? selected;
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
          <Link to="/games">{translateUi('← All games')}</Link>
          <p className="number-eyebrow">{translateUi('SALEM BET ORIGINAL · FREE PRACTICE')}</p>
          <h1>
            {translateUi('Number') + ' '}
            <span>{translateUi('Challenge')}</span>
          </h1>
          <p>{translateUi('One-minute rounds · 30 seconds to choose · one shared target.')}</p>
        </div>
        <label className="number-motion">
          <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} />{' '}
          {translateUi('Reduced motion')}
        </label>
      </header>
      <GameRoundSummary
        game="Number Challenge"
        label={
          target != null
            ? translateUi('Round result')
            : accepted
              ? translateUi('Guess accepted')
              : translateUi('Choose 1–100')
        }
        value={
          target != null
            ? `Target ${target}`
            : accepted
              ? `Your number ${accepted.guess}`
              : 'Target hidden'
        }
        detail={
          display
            ? `${display.away === 0 ? 'Exact match' : `${display.away} away`} · ${display.score} practice score`
            : 'Free practice · one guess per round'
        }
        clock={`${clockLabel} ${ready && current ? `00:${String(seconds).padStart(2, '0')}` : ''}`}
      />
      <div className="number-layout">
        <GameArena title={translateUi('Number Challenge')}>
          <div className={`number-stage ${busy ? 'is-revealing' : ''}`}>
            <div className="number-stage-top">
              <span className="number-wordmark">
                {'N'}
                <span>º</span>
                {' ' + translateUi('/ CHALLENGE')}
              </span>
              <span className="number-badge">1 — 100</span>
            </div>
            <div className={`number-countdown ${open ? '' : 'number-countdown--closed'}`}>
              <span>{clockLabel}</span>
              <strong aria-label={translateUi('Round countdown')}>
                {ready && current ? `00:${String(seconds).padStart(2, '0')}` : '—'}
              </strong>
              <div className="number-countdown-track" aria-hidden="true">
                <i style={{ width: `${(seconds / 30) * 100}%` }} />
              </div>
            </div>
            <p className="number-eyebrow">
              {target != null
                ? translateUi('SHARED ROUND RESULT')
                : open
                  ? translateUi('ENTRY WINDOW OPEN')
                  : translateUi('ENTRIES CLOSED')}
            </p>
            <div key={round?.id ?? 'waiting'} className="number-ball" aria-hidden="true">
              <div className="number-orbit" aria-hidden="true" />
              <span>{target != null ? String(target).padStart(2, '0') : '?'}</span>
            </div>
            <div className="number-result" role="status" aria-live="polite">
              {busy ? (
                <>
                  <h2>{translateUi('Confirming your guess…')}</h2>
                  <p>{translateUi('Your guess is saved while we confirm it.')}</p>
                </>
              ) : display ? (
                <>
                  <h2>
                    {display.away === 0
                      ? translateUi('Exact match!')
                      : translateUi('{away} away', { away: display.away ?? '' })}
                  </h2>
                  <p>
                    {translateUi('Your number') + ' '}
                    <b>{display.guess}</b>
                    {' ' + translateUi('· Target') + ' '}
                    <b>{display.target}</b>
                  </p>
                  <strong>
                    {translateUi('{score} practice score', { score: display.score ?? '' })}
                  </strong>
                </>
              ) : accepted ? (
                <>
                  <h2>{translateUi('Guess accepted: {guess}', { guess: accepted.guess })}</h2>
                  <p>
                    {open
                      ? translateUi('Your number is locked. Result after entries close.')
                      : translateUi('Waiting for the confirmed result…')}
                  </p>
                </>
              ) : target != null ? (
                <>
                  <h2>{translateUi('Target: {target}', { target: target })}</h2>
                  <p>
                    {translateUi(
                      'You did not enter this round. Choose a number in the next round.'
                    )}
                  </p>
                </>
              ) : (
                <>
                  <h2>
                    {open
                      ? translateUi('Place your guess')
                      : current
                        ? translateUi('Waiting for the result')
                        : translateUi('Syncing the next round')}
                  </h2>
                  <p>{translateUi('One guess per round. The server confirms the closing time.')}</p>
                </>
              )}
            </div>
            <p className="number-stage-note">
              {translateUi(
                'Independent random targets · previous results cannot predict the next number'
              )}
            </p>
          </div>
        </GameArena>
        <section className="number-panel" aria-labelledby="number-pick-title">
          <p className="number-eyebrow">
            {clockLabel} {ready && current ? `00:${String(seconds).padStart(2, '0')}` : ''}
          </p>
          <h2 id="number-pick-title">{translateUi('Choose your number')}</h2>
          <label htmlFor="number-guess">{translateUi('Number from 1 to 100')}</label>
          <div className="number-stepper">
            <button
              aria-label={translateUi('Decrease number')}
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
              value={accepted ? String(accepted.guess) : pending ? String(pending.guess) : guess}
              disabled={controlsLocked}
              onChange={(e) => setGuess(e.target.value)}
              aria-invalid={!!inputError}
              aria-describedby="number-input-help"
            />
            <button
              aria-label={translateUi('Increase number')}
              disabled={controlsLocked || !Number.isInteger(selected) || selected >= 100}
              onClick={() => setGuess(String(selected + 1))}
            >
              +
            </button>
          </div>
          <p id="number-input-help">
            {inputError || translateUi('Every target from 1 to 100 is equally likely.')}
          </p>
          <input
            aria-label={translateUi('Choose number with slider')}
            type="range"
            min="1"
            max="100"
            step="1"
            value={Number.isInteger(shownGuess) ? Math.min(100, Math.max(1, shownGuess)) : 50}
            disabled={controlsLocked}
            onChange={(e) => setGuess(e.target.value)}
          />
          <div className="number-presets">
            {[1, 25, 50, 75, 100].map((n) => (
              <button
                key={n}
                aria-pressed={shownGuess === n}
                disabled={controlsLocked}
                onClick={() => setGuess(String(n))}
              >
                {n}
              </button>
            ))}
          </div>
          {query.isPending && <p role="status">{translateUi('Loading practice…')}</p>}
          {query.isError && (
            <div role="alert">
              <p>
                {translateUi('Practice is unavailable. Check your connection or sign in again.')}
              </p>
              <button onClick={() => void query.refetch()}>{translateUi('Retry loading')}</button>
            </div>
          )}
          {query.data && query.data.rulesId !== NUMBER_TIMED_RULES_ID && (
            <p role="alert">
              {translateUi('The game rules have changed. Reload the app before playing.')}
            </p>
          )}
          {pending && (
            <p className="number-notice">
              {translateUi('Saved guess:') + ' '}
              <b>{pending.guess}</b>
              {translateUi('. Check this saved request before choosing another number.')}
            </p>
          )}
          {error && (
            <p role="alert" className="number-notice">
              {translateUi(error)}
            </p>
          )}
          <button
            className="number-submit"
            disabled={!ready || busy || (!pending && (!canPlace || !!inputError))}
            onClick={() => void submit()}
          >
            {busy
              ? translateUi('Confirming…')
              : pending
                ? translateUi('Retry saved guess')
                : accepted
                  ? translateUi('Guess placed')
                  : !open
                    ? translateUi('Entries closed')
                    : translateUi('Place guess')}
          </button>
          <p className="number-free">
            {translateUi('Free to play · no stakes or cash prizes.')}
            <br />
            {translateUi('Practice scores cannot be spent or transferred.')}
          </p>
        </section>
      </div>
      <section className="number-panel" aria-labelledby="number-history-title">
        <p className="number-eyebrow">{translateUi('YOUR LAST 20 ROUNDS')}</p>
        <h2 id="number-history-title">{translateUi('Recent results')}</h2>
        {rounds.length ? (
          <div className="number-history">
            <table>
              <thead>
                <tr>
                  <th>{translateUi('Time')}</th>
                  <th>{translateUi('Your number')}</th>
                  <th>{translateUi('Target')}</th>
                  <th>{translateUi('Distance')}</th>
                  <th>{translateUi('Score')}</th>
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
                      {r.away === null
                        ? translateUi('Pending')
                        : r.away === 0
                          ? translateUi('Exact')
                          : translateUi('{away} away', { away: r.away })}
                    </td>
                    <td>{r.score ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="number-empty">
            {translateUi('Your confirmed results will appear here after your first guess.')}
          </p>
        )}
      </section>
      <section className="number-panel number-scoring" aria-labelledby="number-scoring-title">
        <div>
          <p className="number-eyebrow">{translateUi('KNOW YOUR SCORE')}</p>
          <h2 id="number-scoring-title">{translateUi('Closer is better')}</h2>
        </div>
        <div className="number-bands">
          {NUMBER_BANDS.map((b) => (
            <div key={b.distance}>
              <b>{b.score}</b>
              <span>{translateUi(b.label)}</span>
            </div>
          ))}
        </div>
        <details>
          <summary>{translateUi('How to play & fairness')}</summary>
          <p>
            {translateUi(
              'Each round lasts one minute. During the first 30 seconds, choose an integer from 1 to 100 and select Place guess. You can place one guess per round and cannot change it after acceptance. Entries close for the final 30 seconds, when everyone sees the same random target. A delayed connection may cause a guess to arrive too late; server time decides acceptance. Your score follows the distance bands above. An exact match has a 1 in 100 chance. Numbers near the ends of the range have fewer nearby targets; proximity scores are not equally likely for every guess.'
            )}
          </p>
          <p>
            {translateUi(
              'The target is selected by the server’s cryptographic random generator after the entry window closes. If the server is delayed, results remain pending until confirmed. This is not a precommitted, independently verifiable draw. The animation only presents the saved result. Retrying a saved guess returns that same result. Scores are for this game only and have no cash value.'
            )}
          </p>
          <p>
            {translateUi(
              'Rules: {NUMBER_TIMED_RULES_ID}. Original Salem Bet game, not affiliated with 1xBet.',
              { NUMBER_TIMED_RULES_ID: NUMBER_TIMED_RULES_ID }
            )}
          </p>
        </details>
      </section>
    </div>
  );
}
