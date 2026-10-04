import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { SYSTEM_DICE_RULES as rules, parseDiceStake } from '@socialplay/shared';
import type { SystemDiceSnapshot } from '@socialplay/shared';
import { useAuth } from '@/providers/auth-provider';
import { useCasino } from '@/components/casino/CasinoProvider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import './dice-system.css';

const endpoint = '/games/system-dice';
type Entry = { roundId: string; stake: number };
export const dicePendingKey = (userId: string) => `playqube.pending-dice.${userId}`;
function readPending(userId: string): { entry: Entry | null; error: string } {
  try {
    const raw = sessionStorage.getItem(dicePendingKey(userId));
    if (!raw) return { entry: null, error: '' };
    const item = JSON.parse(raw) as Entry;
    if (typeof item.roundId !== 'string' || !item.roundId || item.roundId.length > 64) throw Error('Invalid receipt');
    parseDiceStake(item.stake);
    return { entry: { roundId: item.roundId, stake: item.stake }, error: '' };
  } catch { return { entry: null, error: 'Your saved ticket could not be read. Restore browser storage and reload before entering.' }; }
}
export function DiceFace({ value, hidden = false }: { value: number; hidden?: boolean }) {
  const pips: Record<number, number[]> = { 1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] };
  return <div className="system-die" role="img" aria-label={hidden ? 'Dice awaiting result' : `Die ${value}`}>
    {Array.from({length:9},(_,i)=><span key={i} className={!hidden&&pips[value]?.includes(i)?'pip':'empty'} />)}
  </div>;
}
export function SystemDicePage() { const { user } = useAuth(); return user ? <SystemDice key={user.id} userId={user.id}/> : null; }
function SystemDice({userId}:{userId:string}) {
  const {coinsBalance,walletLoading,walletError} = useCasino();
  const [clock,setClock] = useState(performance.now());
  const [stakeText,setStakeText] = useState('35');
  const [initial] = useState(()=>readPending(userId));
  const [pending,setPending] = useState<Entry|null>(initial.entry);
  const pendingRef = useRef(initial.entry), mounted = useRef(true);
  const [storageError,setStorageError] = useState(initial.error);
  const [notice,setNotice] = useState(initial.entry?'Your earlier ticket needs confirmation. Retry keeps its exact amount and round.':'Choose your amount and confirm before the timer reaches zero.');
  let stake = 0;
  try { if (/^\d+$/.test(stakeText)) stake = parseDiceStake(Number(stakeText)); } catch { /* shown next to the field */ }
  const query = useQuery({queryKey:['system-dice',userId],queryFn:async({signal})=>{
    const sentAt = performance.now();
    const snapshot = unwrapData(await boundedRequest(s=>api.get<SystemDiceSnapshot>(endpoint,undefined,{signal:s}),signal));
    return {snapshot,sentAt,receivedAt:performance.now()};
  },refetchInterval:1000,refetchOnWindowFocus:true,refetchOnReconnect:true,retry:false});
  useEffect(()=>{mounted.current=true;const timer=setInterval(()=>setClock(performance.now()),100);return()=>{mounted.current=false;clearInterval(timer);};},[]);
  const s=query.data?.snapshot, age=query.data?Math.max(clock,performance.now())-query.data.sentAt:Infinity;
  const connected=!!query.data&&!query.isError&&!query.isPaused&&age<5000&&query.data.receivedAt-query.data.sentAt<1000;
  const now=s?s.serverTime+age:0;
  const round=s?.rounds.find(r=>r.opensAt<=now&&now<r.endsAt);
  const display=round??s?.rounds[0];
  const open=!!round&&connected&&s?.enabled&&s.rulesId===rules.id&&now<round.closesAt&&round.outcome===null;
  const revealing=!!round&&now>=round.closesAt&&now<round.closesAt+rules.revealMs;
  const resultVisible=!!display?.outcome&&now>=display.closesAt+rules.revealMs;
  const dice=resultVisible?display!.outcome:null;
  const sum=dice?dice[0]+dice[1]:null;
  const ticket=round?.ticket;
  const shownStake=ticket?.stake??pending?.stake??stake;
  const possibleReturn=shownStake/35*54;
  const seconds=round?Math.max(0,Math.ceil(((now<round.closesAt?round.closesAt:round.endsAt)-now)/1000)):0;
  const locked=!open||!!ticket||!!pending||!!storageError;
  function clearPending(entry:Entry) {
    if(!mounted.current||pendingRef.current!==entry)return;
    try {
      if(sessionStorage.getItem(dicePendingKey(userId))===JSON.stringify(entry)) sessionStorage.removeItem(dicePendingKey(userId));
      pendingRef.current=null;setPending(null);setStorageError('');
    } catch { setStorageError('Your ticket is saved on the server, but browser storage could not be updated. Reload to confirm it.'); }
  }
  const mutation=useMutation({mutationFn:(entry:Entry)=>boundedRequest(signal=>api.post(`${endpoint}/tickets`,entry,undefined,{signal})),
    onSuccess:async(_data,entry)=>{if(!mounted.current||pendingRef.current!==entry)return;clearPending(entry);setNotice('Ticket confirmed. Your amount is locked for this round.');await query.refetch();},
    onError:async(error,entry)=>{if(!mounted.current||pendingRef.current!==entry)return;const status=requestStatus(error);
      if(status===400||status===404||status===409)clearPending(entry);
      setNotice(status===409?'Betting closed or a ticket is already confirmed. Checking the server.':status===400?'The ticket was not accepted. Check your balance and amount.':'The response was interrupted. Retry the saved ticket to confirm its outcome.');
      await query.refetch();
    },
  });
  useEffect(()=>{
    const entry=pendingRef.current;if(!entry||!connected)return;
    const accepted=s?.rounds.find(r=>r.id===entry.roundId)?.ticket;
    if(accepted){clearPending(entry);mutation.reset();setNotice(accepted.stake===entry.stake?'Confirmed by the server. Your ticket is saved.':'This round already has a different confirmed ticket. The server ticket is shown.');}
  },[query.data,pending,connected]);
  function submit(entry:Entry) {
    if(pendingRef.current&&pendingRef.current!==entry)return;
    try {sessionStorage.setItem(dicePendingKey(userId),JSON.stringify(entry));setStorageError('');}
    catch {setStorageError('Enable browser storage before confirming. No new ticket was sent.');return;}
    pendingRef.current=entry;setPending(entry);mutation.mutate(entry);
  }
  return <div className="system-dice-page">
    <nav className="system-dice-nav"><Link to="/casino">← Casino</Link><span>System table · Free practice</span></nav>
    <section className="system-dice-stage" aria-label="System Dice practice">
      <header className="system-dice-header"><div><p className="system-dice-eyebrow">PLAYQUBE ORIGINALS</p><h1>Dice <span>Seven Up</span></h1><p>Two dice. One shared result. A new round every minute.</p></div>
        <div className="system-dice-balances"><div><span>ACCOUNT BALANCE</span><strong>{walletLoading?'Loading…':walletError?'Unavailable':`${coinsBalance.toLocaleString()} Coins`}</strong><small>Not used in practice</small></div><div className="practice"><span>PRACTICE BALANCE</span><strong>{s?.balance.toLocaleString()??'—'}</strong><small>Free credits · no cash value</small></div></div>
      </header>
      <div className="system-dice-policy"><span><b>90%</b> theoretical return</span><span><b>10%</b> expected house edge</span><span><b>7–12</b> winning total</span></div>
      {!connected&&<p role="alert" className="system-dice-connection">{query.isPending?'Connecting to the system table…':requestStatus(query.error)===403?'Dice practice is unavailable. No ticket can be placed.':'Reconnecting. Entry is paused until a fresh server update arrives.'}</p>}
      {connected&&!round&&<p role="status" className="system-dice-connection">Waiting for the next scheduled round…</p>}
      <div className="system-dice-layout"><div className="system-dice-table">
        <div className="system-dice-round"><span className="system-dice-live"><i/>{open?'BETTING OPEN':revealing?'ROLLING':resultVisible?'RESULT':'WAITING'}</span><span role="timer" aria-label={open?'Betting closes in':'Next round in'}>{String(seconds).padStart(2,'0')}<small>s</small></span></div>
        <div className={`system-dice-cup ${revealing?'is-rolling':''}`} aria-busy={revealing}><DiceFace value={dice?.[0]??3} hidden={!dice}/><DiceFace value={dice?.[1]??4} hidden={!dice}/></div>
        <div className="system-dice-result" role="status">{sum!==null?<><span>THE TOTAL IS</span><strong>{sum}</strong><p>{sum>=7?'Seven up · winning result':'Below seven · no return'}</p>{display?.ticket&&<small>{display.ticket.payout===null?'Your return is being confirmed…':`${display.ticket.payout} practice credits returned`}</small>}</>:<><span>{revealing?'DICE IN MOTION':'THE MAGIC NUMBER'}</span><strong>7<span>+</span></strong><p>{ticket?'Your ticket is confirmed. Good luck!':revealing?'Entries are locked. The server is revealing the roll.':'A total of 7 or higher wins.'}</p></>}</div>
        <div className="system-dice-track" aria-hidden="true">{Array.from({length:11},(_,i)=>i+2).map(n=><span key={n} className={`${n>=7?'wins':''} ${sum===n?'current':''}`}>{n}</span>)}</div>
        <p className="system-dice-round-id">{display?.id??'Synchronizing with the table'}</p>
      </div><aside className="system-dice-ticket" aria-label="Your Dice ticket">
        <p className="system-dice-eyebrow">YOUR TICKET</p><h2>Make your play</h2><p>Confirm once. Watch the same roll as everyone at this table.</p>
        <label htmlFor="system-dice-stake">Bet amount</label><div className="system-dice-input"><input id="system-dice-stake" inputMode="numeric" value={ticket?String(ticket.stake):pending?String(pending.stake):stakeText} onChange={e=>setStakeText(e.target.value)} disabled={locked} aria-invalid={!stake&&!ticket&&!pending} aria-describedby="dice-stake-help"/><span>credits</span></div>
        <p id="dice-stake-help" className={!stake&&!ticket&&!pending?'invalid':''}>35–490 credits · steps of 35</p>
        <div className="system-dice-presets">{[35,70,140].map(amount=><button key={amount} disabled={locked} onClick={()=>setStakeText(String(amount))}>{amount}</button>)}</div>
        <dl><div><dt>Return on a win</dt><dd>{possibleReturn||'—'} credits</dd></div><div><dt>Win probability</dt><dd>21 / 36 · 58.33%</dd></div><div><dt>Additional fee</dt><dd>None</dd></div></dl>
        <button className="system-dice-confirm" disabled={locked||!stake||stake>(s?.balance??0)} onClick={()=>round&&submit({roundId:round.id,stake})}>{ticket?'Ticket confirmed':pending?'Confirming saved ticket…':`Confirm ticket · ${stake||'—'} credits`}</button>
        {pending&&!mutation.isPending&&<button className="system-dice-retry" disabled={!connected} onClick={()=>submit(pending)}>Retry saved ticket · {pending.stake} credits</button>}
        {!ticket&&stake>(s?.balance??Infinity)&&<p role="alert" className="invalid">Not enough practice credits for this amount.</p>}
        {storageError&&<p role="alert" className="invalid">{storageError}</p>}<p className="system-dice-notice" aria-live="polite">{notice}</p>
        <p className="system-dice-disclosure">Returns include the original stake. A 35-credit win returns 54 credits: 19 credits net.</p>
      </aside></div>
      <footer className="system-dice-footer"><div><span>01</span><p><strong>45 seconds to enter</strong>Type an amount and confirm. Tickets are never placed automatically.</p></div><div><span>02</span><p><strong>10 seconds to reveal</strong>The server saves one roll. Refreshing never starts a new round.</p></div><div><span>03</span><p><strong>5 seconds for results</strong>Returns go to your practice balance automatically.</p></div></footer>
    </section>
    <section className="system-dice-history"><h2>Recent rolls</h2><p>Your saved tickets and returns are restored after refresh.</p><div>{s?.rounds.filter(r=>r.outcome&&now>=r.closesAt+rules.revealMs).map(r=><article key={r.id}><span className={(r.outcome![0]+r.outcome![1])>=7?'win':'loss'}>{r.outcome![0]+r.outcome![1]}</span><div><strong>{r.outcome!.join(' + ')}</strong><small>{r.id}</small></div><p>{r.ticket?`${r.ticket.stake} staked · ${r.ticket.payout??'pending'} returned`:'No ticket'}</p></article>)}{!s?.rounds.some(r=>r.outcome&&now>=r.closesAt+rules.revealMs)&&<p>Results will appear after the first completed roll.</p>}</div></section>
    <details className="system-dice-rules"><summary>How the return works</summary><p>There are 36 equally likely pairs of dice; 21 have a total of 7 or higher. Each 35-credit stake returns 54 on a win and zero otherwise. (21 ÷ 36) × (54 ÷ 35) = 90% theoretical gross return over repeated play. The 10% expected edge is built into the return, with no additional ticket fee.</p><p>Practice credits start at 1,000, cannot be bought, transferred, gifted or converted, and are separate from Coins and Game Points. If the connection or worker is interrupted, entry pauses and saved tickets settle against their original roll when service resumes. Existing group PVP games use a separate 7% completion fee.</p></details>
  </div>;
}
