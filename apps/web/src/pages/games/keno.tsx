import { formatEtb } from '@/lib/payment-money';
import { useEffect, useId, useRef, useState } from 'react';
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

export function KenoMachine({ number, running }: { number: number | null; running: boolean }) {
  const id = useId().replaceAll(':', '');
  const paint = (name: string) => `url(#${id}-${name})`;
  return (
    <div className={`keno-machine ${running ? 'keno-machine-running' : ''}`}>
      <svg
        viewBox="0 0 380 360"
        role="img"
        aria-label={number === null ? 'Keno ball machine ready' : `Latest drawn ball ${number}`}
      >
        <defs>
          <linearGradient id={`${id}-metal`}>
            <stop stopColor="#3d2632" />
            <stop offset=".23" stopColor="#f4d3ae" />
            <stop offset=".43" stopColor="#8c6559" />
            <stop offset=".62" stopColor="#fff1d9" />
            <stop offset="1" stopColor="#503440" />
          </linearGradient>
          <radialGradient id={`${id}-glass`} cx=".35" cy=".2">
            <stop stopColor="#b4dfed" stopOpacity=".3" />
            <stop offset=".6" stopColor="#24495b" stopOpacity=".25" />
            <stop offset="1" stopColor="#07111b" stopOpacity=".9" />
          </radialGradient>
          <radialGradient id={`${id}-ball`} cx=".3" cy=".24" r=".8">
            <stop stopColor="#fff9dd" />
            <stop offset=".25" stopColor="#ffe5a0" />
            <stop offset=".65" stopColor="#d39b49" />
            <stop offset="1" stopColor="#593121" />
          </radialGradient>
          <radialGradient id={`${id}-ruby`} cx=".3" cy=".2">
            <stop stopColor="#e7b5c2" />
            <stop offset=".35" stopColor="#b34e6b" />
            <stop offset="1" stopColor="#3c1126" />
          </radialGradient>
          <radialGradient id={`${id}-base`}>
            <stop stopColor="#543442" />
            <stop offset="1" stopColor="#160d18" />
          </radialGradient>
          <clipPath id={`${id}-chamber`}>
            <circle cx="190" cy="129" r="103" />
          </clipPath>
        </defs>
        <ellipse cx="190" cy="340" rx="144" ry="15" fill="#000" opacity=".35" />
        <path d="M90 285L112 205H268L290 285Z" fill={paint('metal')} stroke="#d8ab86" />
        <path d="M108 285L125 216H255L272 285Z" fill="#1a1220" />
        <ellipse cx="190" cy="279" rx="137" ry="27" fill={paint('metal')} />
        <path
          d="M53 279V307C53 345 327 345 327 307V279C318 316 62 316 53 279Z"
          fill={paint('base')}
          stroke="#a27a65"
        />
        <ellipse cx="190" cy="129" rx="113" ry="115" fill={paint('metal')} />
        <circle cx="190" cy="129" r="106" fill="#081824" />
        <g clipPath={paint('chamber')} aria-hidden="true">
          <circle cx="190" cy="129" r="104" fill={paint('glass')} />
          {Array.from({ length: 18 }, (_, i) => {
            const x = 116 + (i % 5) * 35 + (Math.floor(i / 5) % 2) * 13;
            const y = 78 + Math.floor(i / 5) * 37;
            return (
              <g
                key={i}
                className="keno-tumble"
                style={{
                  animationDelay: `${-i * 0.17}s`,
                  animationDuration: `${1.15 + (i % 4) * 0.23}s`,
                }}
              >
                <circle cx={x + 3} cy={y + 4} r={16 + (i % 3)} fill="#000" opacity=".28" />
                <circle
                  cx={x}
                  cy={y}
                  r={16 + (i % 3)}
                  fill={paint(i % 3 === 0 ? 'ruby' : 'ball')}
                />
                <ellipse cx={x - 5} cy={y - 7} rx="5" ry="3" fill="#fff" opacity=".32" />
              </g>
            );
          })}
          <ellipse
            cx="165"
            cy="64"
            rx="60"
            ry="24"
            fill="#e4f6ff"
            opacity=".12"
            transform="rotate(-25 165 64)"
          />
        </g>
        <circle
          cx="190"
          cy="129"
          r="104"
          fill="none"
          stroke="#cbebf1"
          strokeOpacity=".35"
          strokeWidth="2"
        />
        <path
          d="M100 116Q109 56 160 38"
          fill="none"
          stroke="#fff6e5"
          strokeWidth="5"
          strokeLinecap="round"
          opacity=".6"
        />
        <path
          d="M276 149Q263 201 227 215"
          fill="none"
          stroke="#9ec7d9"
          strokeWidth="3"
          opacity=".35"
        />
        <rect x="165" y="228" width="50" height="35" rx="9" fill={paint('metal')} />
        <ellipse
          cx="190"
          cy="277"
          rx="65"
          ry="24"
          fill="#060e16"
          stroke="#e3b48a"
          strokeWidth="3"
        />
        <g className="keno-reveal-ball" key={number ?? 'ready'}>
          <circle cx="190" cy="277" r="48" fill={paint('ball')} />
          <circle cx="190" cy="277" r="29" fill="#fff2cb" opacity=".9" />
          <text
            x="190"
            y="290"
            textAnchor="middle"
            fontFamily="Arial, sans-serif"
            fontWeight="900"
            fontSize="38"
            fill="#382016"
          >
            {number ?? '—'}
          </text>
          <ellipse
            cx="175"
            cy="249"
            rx="14"
            ry="6"
            fill="#fff"
            opacity=".5"
            transform="rotate(-25 175 249)"
          />
        </g>
        {[95, 116, 137, 243, 264, 285].map((x) => (
          <circle key={x} cx={x} cy="310" r="3" fill="#f9d8a1" />
        ))}
        <text x="190" y="349" textAnchor="middle" fontSize="10" letterSpacing="3" fill="#e9c5a9">
          {number === null ? 'READY TO DRAW' : 'LATEST DRAWN BALL'}
        </text>
      </svg>
      <p>{running ? 'MIXING & REVEALING' : 'LIVE DRAW CHAMBER'}</p>
    </div>
  );
}

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
        <Link to="/games">← Games</Link>
        <span>Practice · this tab</span>
      </div>
      <section className="keno-stage" aria-label="Turbo Keno practice">
        <header className="keno-header">
          <div>
            <p className="keno-eyebrow">SALEM BET ORIGINALS</p>
            <h1>
              Turbo <span>Keno</span>
            </h1>
            <p>Every ball brings a new possibility.</p>
          </div>
          <div className="keno-balances">
            <div className="keno-wallet">
              <span>ACCOUNT BALANCE</span>
              <strong>
                {walletLoading
                  ? 'Loading…'
                  : walletError
                    ? 'Unavailable'
                    : formatEtb(coinsBalance)}
              </strong>
              <small>Not used in practice</small>
            </div>
            <div className="keno-balance">
              <span>PRACTICE BALANCE</span>
              <strong>{state.balance.toLocaleString()}</strong>
              <small>credits · no cash value</small>
            </div>
          </div>
        </header>
        <div className="keno-economics">
          <span>{HOUSE_GAME_POLICY.targetRtpBps / 100}% theoretical return</span>
          <span>{HOUSE_GAME_POLICY.expectedHouseEdgeBps / 100}% expected house edge</span>
          <span>3.6× return per matching number</span>
        </div>
        <div className="keno-practice-note">
          Practice only · Local demo draw · No deposits or redeemable prizes
        </div>
        <div className="keno-layout">
          <div className="keno-board-panel">
            <div className="keno-draw-heading">
              <h2>
                DRAW <span>{String(round?.id ?? state.nextId).padStart(3, '0')}</span>
              </h2>
              <span>
                {state.active ? 'REVEALING' : round ? 'DRAW COMPLETE' : 'READY TO PLAY'}{' '}
                <b>{count}/20</b>
              </span>
            </div>
            <div className="keno-board" role="group" aria-label="Choose Keno numbers">
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
                    aria-label={`Number ${n}${revealed ? ', drawn' : ''}${hit ? ', match' : ''}`}
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
                Selected
              </span>
              <span>
                <i className="legend-drawn" />
                Drawn
              </span>
              <span>
                <i className="legend-hit" />
                Match
              </span>
            </div>
          </div>
          <aside className="keno-machine-panel">
            <div className="keno-machine-title">
              <span>LIVE BALL REVEAL</span>
              <strong>{state.active ? `${count} of 20` : '20 balls · 80 numbers'}</strong>
            </div>
            <KenoMachine number={drawn.at(-1) ?? null} running={!!state.active} />
            <div className="keno-result" role="status" aria-live="polite">
              {state.active
                ? `${count} of 20 revealed · ${hits.length} matches`
                : round
                  ? `${round.picks.filter((n) => round.numbers.includes(n)).length} matches · ${kenoReturn(round)} credits returned`
                  : 'Select your numbers, then start the draw.'}
            </div>
          </aside>
        </div>
        <div className="keno-stake-panel">
          <div>
            <label htmlFor="keno-bet-amount">Bet amount per number</label>
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
              <span>practice credits</span>
            </div>
            <p id="keno-stake-help">
              {!state.active && !stakeValid
                ? 'Use steps of 5, within your practice balance and the 480-credit ticket limit.'
                : 'Steps of 5 · Maximum 480 credits per ticket · Amount locks when the draw starts.'}
            </p>
          </div>
          <div className="keno-ticket-summary">
            <span>TOTAL BET</span>
            <strong>{ticketCost.toLocaleString()} credits</strong>
            <small>
              {shownPicks.length} numbers × {displayedStake || '—'} credits
            </small>
            <small>
              Each match returns{' '}
              {displayedStake
                ? (displayedStake / KENO_90_RULES.stakeStep) * KENO_90_RULES.returnPerStep
                : '—'}{' '}
              credits
            </small>
          </div>
        </div>
        <div className="keno-controls">
          <div>
            <h2>{shownPicks.length}/10 numbers selected</h2>
            <p>{notice}</p>
            <p className="keno-picks">
              {shownPicks.length ? shownPicks.join(' · ') : 'Your selections appear here'}
            </p>
          </div>
          <div className="keno-actions">
            <button disabled={!!state.active} onClick={quickPick}>
              Quick pick 5
            </button>
            <button disabled={!!state.active || !picks.length} onClick={() => setPicks([])}>
              Clear
            </button>
            <button
              className="keno-play"
              disabled={!!state.active || !picks.length || !stakeValid}
              onClick={play}
            >
              {state.active ? 'Drawing…' : `Start draw · ${ticketCost} credits`}
            </button>
          </div>
        </div>
        <footer className="keno-footer">
          <details>
            <summary>Practice rules & recent draws</summary>
            <p>
              Select 1–10 numbers. Choose a stake in steps of 5 for each selected number. A matching
              number returns 3.6× its stake (18 for every 5 credits) if included among the 20 drawn
              numbers. Returns include the stake on that number. Every draw has 20 different numbers
              from 1–80.
            </p>
            <p>
              Each number has a 20/80 chance of being drawn. A 25% chance × 3.6× total return gives
              90% theoretical return and a 10% expected house edge over repeated play; this is not a
              guarantee for an individual draw.
            </p>
            <p>
              Common house-game rule: solo, shared and group play use the same payout table and 90%
              theoretical return. Group house games have no additional group fee. Pooled
              competitions are separate.
            </p>
            <p>
              This local practice session resumes after a refresh in this tab. Shared server draws
              and cash play are not available here.
            </p>
            <ol>
              {state.history.map((r) => (
                <li key={r.id}>
                  <strong>Draw {String(r.id).padStart(3, '0')}</strong> · {r.numbers.join(', ')} ·
                  Return {kenoReturn(r)}
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
            Reset practice
          </button>
        </footer>
        {storageWarning && (
          <p className="keno-storage" role="alert">
            Browser storage is unavailable. This practice session will reset if you refresh.
          </p>
        )}
      </section>
    </div>
  );
}
