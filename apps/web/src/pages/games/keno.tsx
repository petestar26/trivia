import { KenoMachine } from '@/components/keno/draw-machine';
export { KenoMachine } from '@/components/keno/draw-machine';
import { formatEtb } from '@/lib/payment-money';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import {
  advanceKeno,
  drawKeno,
  kenoReturn,
  loadKeno,
  newKenoState,
  revealedCount,
  startKeno,
} from '@/lib/keno-practice';
import type { KenoState } from '@/lib/keno-practice';
import { useCasino } from '@/components/casino/CasinoProvider';
import { HOUSE_GAME_POLICY, KENO_90_RULES } from '@socialplay/shared';
import { parseKenoStake, KENO_MAX_PRACTICE_STAKE } from '@/lib/keno-practice';
import './keno.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function KenoPage() {
  const { user } = useAuth();
  return (
    <KenoSession
      key={user?.id ?? 'guest'}
      storageKey={`playqube.keno.practice.v1.${user?.id ?? 'guest'}`}
    />
  );
}

function KenoSession({ storageKey }: { storageKey: string }) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const [state, setState] = useState<KenoState>(() => {
    try {
      return advanceKeno(loadKeno(sessionStorage.getItem(storageKey)), Date.now());
    } catch {
      return newKenoState();
    }
  });
  const current = useRef(state);
  const [picks, setPicks] = useState<number[]>([]);
  const [stakeText, setStakeText] = useState('5');
  const stake = parseKenoStake(stakeText);
  const { coinsBalance, walletLoading, walletError } = useCasino();
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState('Choose your numbers to begin.');
  const [storageWarning, setStorageWarning] = useState(false);
  const publish = (next: KenoState) => {
    current.current = next;
    setState(next);
  };
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(state));
      setStorageWarning(false);
    } catch {
      setStorageWarning(true);
    }
  }, [state, storageKey]);
  useEffect(() => {
    if (!state.active) return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      const next = advanceKeno(current.current, time);
      if (next !== current.current) publish(next);
    };
    const timer = setInterval(tick, 100);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [state.active]);
  const round = state.active ?? state.history[0];
  const count = state.active ? revealedCount(state.active, now) : round ? 20 : 0;
  const drawn = round?.numbers.slice(0, count) ?? [];
  const shownPicks = state.active ? state.active.picks : picks;
  const displayedStake = state.active?.stakePerNumber ?? stake;
  const ticketCost = shownPicks.length * displayedStake;
  const stakeValid = !!stake && ticketCost <= Math.min(state.balance, KENO_MAX_PRACTICE_STAKE);
  const hits = round?.picks.filter((n) => drawn.includes(n)) ?? [];
  const toggle = (n: number) => {
    if (current.current.active) return;
    if (!picks.includes(n) && picks.length >= 10) {
      setNotice('You can choose up to 10 numbers.');
      return;
    }
    setPicks(
      picks.includes(n) ? picks.filter((v) => v !== n) : [...picks, n].sort((a, b) => a - b)
    );
    setNotice('Review your total before starting the draw.');
  };
  const play = () => {
    if (current.current.active) return;
    try {
      const time = Date.now();
      publish(startKeno(current.current, picks, time, undefined, stake));
      setNow(time);
      setNotice('Selections locked. Revealing 20 unique balls.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Draw unavailable. Please try again.');
    }
  };
  const quickPick = () => {
    if (current.current.active) return;
    try {
      setPicks(
        drawKeno()
          .slice(0, 5)
          .sort((a, b) => a - b)
      );
      setNotice('Five numbers selected. You can change them before the draw.');
    } catch {
      setNotice('Number selection unavailable. Please try again.');
    }
  };
  return (
    <div className="keno-page">
      <div className="keno-navigation">
        <Link to="/games">{translateUi('← Games')}</Link>
        <span>{translateUi('Practice · this tab')}</span>
      </div>
      <section className="keno-stage" aria-label={translateUi('Turbo Keno practice')}>
        <header className="keno-header">
          <div>
            <p className="keno-eyebrow">{translateUi('SALEM BET ORIGINALS')}</p>
            <h1>
              {translateUi('Turbo') + ' '}
              <span>{translateUi('Keno')}</span>
            </h1>
            <p>{translateUi('Every ball brings a new possibility.')}</p>
          </div>
          <div className="keno-balances">
            <div className="keno-wallet">
              <span>{translateUi('ACCOUNT BALANCE')}</span>
              <strong>
                {walletLoading
                  ? translateUi('Loading…')
                  : walletError
                    ? translateUi('Unavailable')
                    : formatEtb(coinsBalance)}
              </strong>
              <small>{translateUi('Not used in practice')}</small>
            </div>
            <div className="keno-balance">
              <span>{translateUi('PRACTICE BALANCE')}</span>
              <strong>{state.balance.toLocaleString(interfaceLocale)}</strong>
              <small>{translateUi('credits · no cash value')}</small>
            </div>
          </div>
        </header>
        <div className="keno-economics">
          <span>
            {translateUi('{value}% theoretical return', {
              value: HOUSE_GAME_POLICY.targetRtpBps / 100,
            })}
          </span>
          <span>
            {translateUi('{value}% expected house edge', {
              value: HOUSE_GAME_POLICY.expectedHouseEdgeBps / 100,
            })}
          </span>
          <span>{translateUi('3.6× return per matching number')}</span>
        </div>
        <div className="keno-practice-note">
          {translateUi('Practice only · Local demo draw · No deposits or redeemable prizes')}
        </div>
        <div className="keno-layout">
          <div className="keno-board-panel">
            <div className="keno-draw-heading">
              <h2>
                {translateUi('DRAW') + ' '}
                <span>{String(round?.id ?? state.nextId).padStart(3, '0')}</span>
              </h2>
              <span>
                {state.active
                  ? translateUi('REVEALING')
                  : round
                    ? translateUi('DRAW COMPLETE')
                    : translateUi('READY TO PLAY')}{' '}
                <b>{count}/20</b>
              </span>
            </div>
            <div
              className="keno-board"
              role="group"
              aria-label={translateUi('Choose Keno numbers')}
            >
              {Array.from({ length: 80 }, (_, i) => i + 1).map((n) => {
                const selected = shownPicks.includes(n),
                  revealed = drawn.includes(n),
                  hit = hits.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    disabled={!!state.active}
                    aria-pressed={selected}
                    aria-label={translateUi('Number {n}{value}{value2}', {
                      n: n,
                      value: revealed ? translateUi(', drawn') : '',
                      value2: hit ? translateUi(', match') : '',
                    })}
                    onClick={() => toggle(n)}
                    className={`keno-number ${selected ? 'is-selected' : ''} ${revealed ? 'is-drawn' : ''} ${hit ? 'is-hit' : ''} ${drawn.at(-1) === n ? 'is-latest' : ''}`}
                  >
                    {n}
                    {selected && (
                      <i className="keno-selection-mark" aria-hidden="true">
                        ●
                      </i>
                    )}
                    {hit && <span aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </div>
            <div className="keno-legend">
              <span>
                <i className="legend-selected" />
                {translateUi('Selected')}
              </span>
              <span>
                <i className="legend-drawn" />
                {translateUi('Drawn')}
              </span>
              <span>
                <i className="legend-hit" />
                {translateUi('Match')}
              </span>
            </div>
          </div>
          <aside className="keno-machine-panel">
            <div className="keno-machine-title">
              <span>{translateUi('LIVE BALL REVEAL')}</span>
              <strong>
                {state.active
                  ? translateUi('{count} of 20', { count: count })
                  : translateUi('20 balls · 80 numbers')}
              </strong>
            </div>
            <KenoMachine number={drawn.at(-1) ?? null} running={!!state.active} />
            <div className="keno-result" role="status" aria-live="polite">
              {state.active
                ? translateUi('{count} of 20 revealed · {length} matches', {
                    count: count,
                    length: hits.length,
                  })
                : round
                  ? translateUi('{length} matches · {value} credits returned', {
                      length: round.picks.filter((n) => round.numbers.includes(n)).length,
                      value: kenoReturn(round),
                    })
                  : translateUi('Select your numbers, then start the draw.')}
            </div>
          </aside>
        </div>
        <div className="keno-stake-panel">
          <div>
            <label htmlFor="keno-bet-amount">{translateUi('Bet amount per number')}</label>
            <div className="keno-stake-row">
              <input
                id="keno-bet-amount"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={state.active ? String(state.active.stakePerNumber) : stakeText}
                onChange={(event) => setStakeText(event.target.value)}
                disabled={!!state.active}
                aria-invalid={!state.active && !stakeValid}
                aria-describedby="keno-stake-help"
              />
              <span>{translateUi('practice credits')}</span>
            </div>
            <p id="keno-stake-help">
              {!state.active && !stakeValid
                ? translateUi(
                    'Use steps of 5, within your practice balance and the 480-credit ticket limit.'
                  )
                : translateUi(
                    'Steps of 5 · Maximum 480 credits per ticket · Amount locks when the draw starts.'
                  )}
            </p>
          </div>
          <div className="keno-ticket-summary">
            <span>{translateUi('TOTAL BET')}</span>
            <strong>
              {translateUi('{value} credits', {
                value: ticketCost.toLocaleString(interfaceLocale),
              })}
            </strong>
            <small>
              {translateUi('{length} numbers × {value} credits', {
                length: shownPicks.length,
                value: displayedStake || '—',
              })}
            </small>
            <small>
              {translateUi('Each match returns {value} credits', {
                value: displayedStake
                  ? (displayedStake / KENO_90_RULES.stakeStep) * KENO_90_RULES.returnPerStep
                  : '—',
              })}
            </small>
          </div>
        </div>
        <div className="keno-controls">
          <div>
            <h2>{translateUi('{length}/10 numbers selected', { length: shownPicks.length })}</h2>
            <p>{translateUi(notice)}</p>
            <p className="keno-picks">
              {shownPicks.length
                ? shownPicks.join(' · ')
                : translateUi('Your selections appear here')}
            </p>
          </div>
          <div className="keno-actions">
            <button disabled={!!state.active} onClick={quickPick}>
              {translateUi('Quick pick 5')}
            </button>
            <button disabled={!!state.active || !picks.length} onClick={() => setPicks([])}>
              {translateUi('Clear')}
            </button>
            <button
              className="keno-play"
              disabled={!!state.active || !picks.length || !stakeValid}
              onClick={play}
            >
              {state.active
                ? translateUi('Drawing…')
                : translateUi('Start draw · {ticketCost} credits', { ticketCost: ticketCost })}
            </button>
          </div>
        </div>
        <footer className="keno-footer">
          <details>
            <summary>{translateUi('Practice rules & recent draws')}</summary>
            <p>
              {translateUi(
                'Select 1–10 numbers. Choose a stake in steps of 5 for each selected number. A matching number returns 3.6× its stake (18 for every 5 credits) if included among the 20 drawn numbers. Returns include the stake on that number. Every draw has 20 different numbers from 1–80.'
              )}
            </p>
            <p>
              {translateUi(
                'Each number has a 20/80 chance of being drawn. A 25% chance × 3.6× total return gives 90% theoretical return and a 10% expected house edge over repeated play; this is not a guarantee for an individual draw.'
              )}
            </p>
            <p>
              {translateUi(
                'Common house-game rule: solo, shared and group play use the same payout table and 90% theoretical return. Group house games have no additional group fee. Pooled competitions are separate.'
              )}
            </p>
            <p>
              {translateUi(
                'This local practice session resumes after a refresh in this tab. Shared server draws and cash play are not available here.'
              )}
            </p>
            <ol>
              {state.history.map((r) => (
                <li key={r.id}>
                  <strong>
                    {translateUi('Draw {value}', { value: String(r.id).padStart(3, '0') })}
                  </strong>{' '}
                  · {r.numbers.join(', ')}
                  {' ' + translateUi('· Return') + ' '}
                  {kenoReturn(r)}
                </li>
              ))}
            </ol>
          </details>
          <button
            disabled={!!state.active}
            onClick={() => {
              publish(newKenoState());
              setPicks([]);
              setNotice('New practice session started.');
            }}
          >
            {translateUi('Reset practice')}
          </button>
        </footer>
        {storageWarning && (
          <p className="keno-storage" role="alert">
            {translateUi(
              'Browser storage is unavailable. This practice session will reset if you refresh.'
            )}
          </p>
        )}
      </section>
    </div>
  );
}
