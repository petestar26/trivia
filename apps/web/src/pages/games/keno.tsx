import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { advanceKeno, drawKeno, kenoReturn, loadKeno, newKenoState, revealedCount, startKeno } from '@/lib/keno-practice';
import type { KenoState } from '@/lib/keno-practice';
import './keno.css';

function KenoMachine({ number, running }: { number: number | null; running: boolean }) {
  return <div className={`keno-machine ${running ? 'keno-machine-running' : ''}`}>
    <svg viewBox="0 0 340 400" role="img" aria-label={number === null ? 'Keno ball machine ready' : `Latest drawn ball ${number}`}>
      <defs>
        <linearGradient id="keno-metal"><stop stopColor="#25252c"/><stop offset=".2" stopColor="#f1e6c9"/><stop offset=".46" stopColor="#777580"/><stop offset=".64" stopColor="#fffbe8"/><stop offset="1" stopColor="#373238"/></linearGradient>
        <radialGradient id="keno-ball" cx=".32" cy=".23" r=".85"><stop stopColor="#ffffda"/><stop offset=".28" stopColor="#fff077"/><stop offset=".65" stopColor="#eebd35"/><stop offset="1" stopColor="#8b4609"/></radialGradient>
        <linearGradient id="keno-glass" x2="1" y2="1"><stop stopColor="#fff" stopOpacity=".3"/><stop offset=".35" stopColor="#fff" stopOpacity="0"/><stop offset="1" stopColor="#fff" stopOpacity=".12"/></linearGradient>
      </defs>
      <rect x="137" y="0" width="66" height="400" fill="url(#keno-metal)"/>
      <rect x="145" y="0" width="50" height="400" fill="#690e19"/>
      <ellipse cx="170" cy="370" rx="125" ry="15" fill="#140609" opacity=".5"/>
      <circle cx="170" cy="196" r="134" fill="#1b0b13" stroke="url(#keno-metal)" strokeWidth="12"/>
      <g className="keno-ball"><circle cx="170" cy="196" r="116" fill="url(#keno-ball)"/>
        <text x="170" y="214" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="900" fontSize="94" fill="#27160d">{number ?? '?'}</text>
        <text x="170" y="251" textAnchor="middle" fontSize="12" letterSpacing="5" fill="#62410f">PLAYQUBE</text>
      </g>
      <circle cx="170" cy="196" r="128" fill="url(#keno-glass)"/>
      <path d="M69 176a104 104 0 0 1 56-74" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" opacity=".35"/>
      {[55,310].map(y=><g key={y}><rect x="86" y={y} width="168" height="28" rx="5" fill="url(#keno-metal)"/><rect x="88" y={y+5} width="164" height="2" fill="#fff" opacity=".5"/></g>)}
    </svg>
    <p>{running ? 'DRAW IN PROGRESS' : 'BALL CHAMBER'}</p>
  </div>;
}

export function KenoPage() {
  const { user } = useAuth();
  return <KenoSession key={user?.id ?? 'guest'} storageKey={`playqube.keno.practice.v1.${user?.id ?? 'guest'}`} />;
}

function KenoSession({ storageKey }: { storageKey: string }) {
  const [state, setState] = useState<KenoState>(() => {
    try { return advanceKeno(loadKeno(sessionStorage.getItem(storageKey)), Date.now()); } catch { return newKenoState(); }
  });
  const current = useRef(state);
  const [picks, setPicks] = useState<number[]>([]);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState('Choose your numbers to begin.');
  const [storageWarning, setStorageWarning] = useState(false);
  const publish = (next: KenoState) => { current.current = next; setState(next); };
  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(state)); setStorageWarning(false); }
    catch { setStorageWarning(true); }
  }, [state, storageKey]);
  useEffect(() => {
    if (!state.active) return;
    const tick = () => { const time = Date.now(); setNow(time); const next = advanceKeno(current.current, time); if (next !== current.current) publish(next); };
    const timer = setInterval(tick, 100);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [state.active]);
  const round = state.active ?? state.history[0];
  const count = state.active ? revealedCount(state.active, now) : round ? 20 : 0;
  const drawn = round?.numbers.slice(0, count) ?? [];
  const shownPicks = state.active ? state.active.picks : picks;
  const hits = round?.picks.filter(n => drawn.includes(n)) ?? [];
  const toggle = (n: number) => {
    if (current.current.active) return;
    if (!picks.includes(n) && picks.length >= 10) { setNotice('You can choose up to 10 numbers.'); return; }
    setPicks(picks.includes(n) ? picks.filter(v => v !== n) : [...picks, n].sort((a,b)=>a-b));
    setNotice('5 practice credits per number. Each matching number returns 18.');
  };
  const play = () => {
    if (current.current.active) return;
    try { const time = Date.now(); publish(startKeno(current.current, picks, time)); setNow(time); setNotice('Selections locked. Revealing 20 unique balls.'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Draw unavailable. Please try again.'); }
  };
  const quickPick = () => {
    if (current.current.active) return;
    try { setPicks(drawKeno().slice(0,5).sort((a,b)=>a-b)); setNotice('Five numbers selected. You can change them before the draw.'); }
    catch { setNotice('Number selection unavailable. Please try again.'); }
  };
  return <div className="keno-page">
    <div className="keno-navigation"><Link to="/casino">← Casino</Link><span>Practice · this tab</span></div>
    <section className="keno-stage" aria-label="Turbo Keno practice">
      <header className="keno-header"><div><p className="keno-eyebrow">PLAYQUBE ORIGINALS</p><h1>Turbo <span>Keno</span></h1><p>Every ball brings a new possibility.</p></div><div className="keno-balance"><span>PRACTICE BALANCE</span><strong>{state.balance.toLocaleString()}</strong><small>credits · no cash value</small></div></header>
      <div className="keno-practice-note">Practice only · Local demo draw · No Coins, deposits or redeemable prizes</div>
      <div className="keno-layout">
        <div className="keno-board-panel">
          <div className="keno-draw-heading"><h2>DRAW <span>{String(round?.id ?? state.nextId).padStart(3,'0')}</span></h2><span>{state.active ? 'REVEALING' : round ? 'DRAW COMPLETE' : 'READY TO PLAY'} <b>{count}/20</b></span></div>
          <div className="keno-board" role="group" aria-label="Choose Keno numbers">
            {Array.from({length:80},(_,i)=>i+1).map(n=>{
              const selected=shownPicks.includes(n), revealed=drawn.includes(n), hit=hits.includes(n);
              return <button key={n} type="button" disabled={!!state.active} aria-pressed={selected} aria-label={`Number ${n}${revealed ? ', drawn' : ''}${hit ? ', match' : ''}`} onClick={()=>toggle(n)} className={`keno-number ${selected?'is-selected':''} ${revealed?'is-drawn':''} ${hit?'is-hit':''} ${drawn.at(-1)===n?'is-latest':''}`}>{n}{selected&&<i className="keno-selection-mark" aria-hidden="true">●</i>}{hit&&<span aria-hidden="true">✓</span>}</button>;
            })}
          </div>
          <div className="keno-legend"><span><i className="legend-selected"/>Selected</span><span><i className="legend-drawn"/>Drawn</span><span><i className="legend-hit"/>Match</span></div>
        </div>
        <aside className="keno-machine-panel"><div className="keno-machine-title"><span>LIVE BALL REVEAL</span><strong>{state.active ? `${count} of 20` : '20 balls · 80 numbers'}</strong></div><KenoMachine number={drawn.at(-1)??null} running={!!state.active}/><div className="keno-result" role="status" aria-live="polite">{state.active ? `${count} of 20 revealed · ${hits.length} matches` : round ? `${round.picks.filter(n=>round.numbers.includes(n)).length} matches · ${kenoReturn(round)} credits returned` : 'Select your numbers, then start the draw.'}</div></aside>
      </div>
      <div className="keno-controls">
        <div><h2>{shownPicks.length}/10 numbers selected</h2><p>{notice}</p><p className="keno-picks">{shownPicks.length ? shownPicks.join(' · ') : 'Your selections appear here'}</p></div>
        <div className="keno-actions"><button disabled={!!state.active} onClick={quickPick}>Quick pick 5</button><button disabled={!!state.active||!picks.length} onClick={()=>setPicks([])}>Clear</button><button className="keno-play" disabled={!!state.active||!picks.length||picks.length*5>state.balance} onClick={play}>{state.active?'Drawing…':`Start draw · ${picks.length*5} credits`}</button></div>
      </div>
      <footer className="keno-footer"><details><summary>Practice rules & recent draws</summary><p>Select 1–10 numbers. Each selected number costs 5 practice credits and returns 18 if included among the 20 drawn numbers. Returns include the stake on that number. Every draw has 20 different numbers from 1–80.</p><p>This local practice session resumes after a refresh in this tab. Shared server draws and Coins play are not available here.</p><ol>{state.history.map(r=><li key={r.id}><strong>Draw {String(r.id).padStart(3,'0')}</strong> · {r.numbers.join(', ')} · Return {kenoReturn(r)}</li>)}</ol></details><button disabled={!!state.active} onClick={()=>{publish(newKenoState());setPicks([]);setNotice('New practice session started.');}}>Reset practice</button></footer>
      {storageWarning&&<p className="keno-storage" role="alert">Browser storage is unavailable. This practice session will reset if you refresh.</p>}
    </section>
  </div>;
}
