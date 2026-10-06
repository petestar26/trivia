import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation,useQuery } from '@tanstack/react-query';
import type { SystemKenoSnapshot } from '@socialplay/shared';
import { useAuth } from '@/providers/auth-provider';
import { useCasino } from '@/components/casino/CasinoProvider';
import { api,unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import { drawKeno,parseKenoStake } from '@/lib/keno-practice';
import { KenoMachine } from './keno';
import './keno.css';
const endpoint='/games/system-keno';
interface Entry {roundId:string;picks:number[];stakePerNumber:number}
export function SystemKenoPage(){const {user}=useAuth();return user?<SystemKeno key={user.id} userId={user.id}/>:null;}
function SystemKeno({userId}:{userId:string}) {
  const {coinsBalance,walletLoading,walletError}=useCasino();
  const [clock,setClock]=useState(performance.now());
  const [draft,setDraft]=useState<{roundId:string;picks:number[]}|null>(null);
  const [stakeText,setStakeText]=useState('5');const stake=parseKenoStake(stakeText);
  const [notice,setNotice]=useState('Choose 1–10 numbers, then confirm your ticket.');
  const [pending,setPending]=useState<Entry|null>(null);const pendingRef=useRef<Entry|null>(null);
  const query=useQuery({queryKey:['system-keno',userId],queryFn:async({signal})=>{
    const sentAt=performance.now();const snapshot=unwrapData(await boundedRequest(s=>api.get<SystemKenoSnapshot>(endpoint,undefined,{signal:s}),signal));
    return {snapshot,sentAt,receivedAt:performance.now()};
  },refetchInterval:q=>[401,403,404].includes(requestStatus(q.state.error))?false:1000,refetchOnWindowFocus:true,refetchOnReconnect:true,retry:false});
  useEffect(()=>{const timer=setInterval(()=>setClock(performance.now()),100);return()=>{clearInterval(timer);pendingRef.current=null;};},[]);
  const s=query.data?.snapshot;const age=query.data?Math.max(clock,performance.now())-query.data.sentAt:Infinity;
  const connected=!!query.data&&!query.isError&&!query.isPaused&&age<5000&&query.data.receivedAt-query.data.sentAt<1000;
  const now=s?s.serverTime+age:0;
  const round=s?.rounds.find(r=>r.opensAt<=now&&now<r.endsAt);
  const display=round??s?.rounds[0];
  const open=!!round&&connected&&s?.enabled&&now<round.closesAt;
  const ticket=round?.ticket;const picks=ticket?.picks??(draft?.roundId===round?.id?draft?.picks??[]:[]);
  const busy=!!pending;const locked=!open||!!ticket||busy;
  const shownStake=ticket?.stakePerNumber??stake;const cost=picks.length*shownStake;
  const count=display?.outcome?Math.min(20,Math.max(0,Math.floor((now-display.closesAt)/500))):0;
  const drawn=display?.outcome?.slice(0,count)??[];
  const hits=display?.ticket?.picks.filter(n=>drawn.includes(n))??[];
  const seconds=round?Math.max(0,Math.ceil(((now<round.closesAt?round.closesAt:round.endsAt)-now)/1000)):0;
  const mutation=useMutation({mutationFn:(entry:Entry)=>boundedRequest(signal=>api.post(`${endpoint}/tickets`,entry,undefined,{signal})),onSuccess:async(_data,entry)=>{
    if(pendingRef.current!==entry)return;pendingRef.current=null;setPending(null);setNotice('Ticket accepted. Your numbers and amount are locked.');await query.refetch();
  },onError:async(error,entry)=>{if(pendingRef.current!==entry)return;const status=requestStatus(error);
    if(status>=400&&status<500&&status!==408){pendingRef.current=null;setPending(null);}
    setNotice(status===409?'Betting closed or your ticket was already confirmed. Checking the server.':'Ticket not confirmed. Checking the server; retry keeps the same ticket.');await query.refetch();}});
  useEffect(()=>{const entry=pendingRef.current;if(!entry)return;
    const accepted=s?.rounds.find(r=>r.id===entry.roundId)?.ticket;
    if(accepted){pendingRef.current=null;setPending(null);mutation.reset();setNotice('Confirmed by the server. Your ticket is saved.');}
  },[query.data,pending]);
  const submit=(entry:Entry)=>{pendingRef.current=entry;setPending(entry);mutation.mutate(entry);};
  const toggle=(n:number)=>{if(locked||!round)return;const next=picks.includes(n)?picks.filter(v=>v!==n):picks.length<10?[...picks,n].sort((a,b)=>a-b):picks;setDraft({roundId:round.id,picks:next});};
  return <div className="keno-page">
    <div className="keno-navigation"><Link to="/casino">← Casino</Link><Link to="/groups">PVP · play in a group →</Link></div>
    <section className="keno-stage" aria-label="System Keno practice">
      <header className="keno-header"><div><p className="keno-eyebrow">PLAYQUBE ORIGINALS · SYSTEM TABLE</p><h1>Turbo <span>Keno</span></h1><p>One new round every minute.</p></div><div className="keno-balances"><div className="keno-wallet"><span>ACCOUNT BALANCE</span><strong>{walletLoading?'Loading…':walletError?'Unavailable':`${coinsBalance.toLocaleString()} Coins`}</strong><small>Not used in practice</small></div><div className="keno-balance"><span>PRACTICE BALANCE</span><strong>{s?.balance.toLocaleString()??'—'}</strong><small>credits · no cash value</small></div></div></header>
      <div className="keno-economics"><span>90% theoretical return</span><span>10% expected house edge</span><span>3.6× return per matching number</span></div>
      <div className="keno-practice-note">Server practice · No Coins, deposits or redeemable prizes · 45 seconds to enter, 15 seconds for results</div>
      {!connected&&<p role="alert" className="px-6 py-3">{query.isPending?'Connecting to the system table…':requestStatus(query.error)===401?'Your session has expired. Sign in again to play.':[403,404].includes(requestStatus(query.error))?'This Keno table is currently unavailable. Please return to the casino.':'Reconnecting. Ticket entry is paused until a fresh server update arrives.'}</p>}
      {connected&&!round&&<p role="status" className="px-6 py-3">Waiting for the next scheduled round…</p>}
      <div className="keno-layout"><div className="keno-board-panel">
        <div className="keno-draw-heading"><h2>{open?'PLACE YOUR TICKET':round?'ENTRIES LOCKED':'SYSTEM TABLE'}</h2><span role="timer" aria-label={open?'Betting closes in':'Next round in'}>{String(seconds).padStart(2,'0')}s <b>{count}/20</b></span></div>
        <div className="keno-board" role="group" aria-label="Choose Keno numbers">{Array.from({length:80},(_,i)=>i+1).map(n=><button key={n} type="button" aria-label={`Number ${n}`} aria-pressed={picks.includes(n)} disabled={locked} onClick={()=>toggle(n)} className={`keno-number ${picks.includes(n)?'is-selected':''} ${drawn.includes(n)?'is-drawn':''} ${hits.includes(n)?'is-hit':''} ${drawn.at(-1)===n?'is-latest':''}`}>{n}{picks.includes(n)&&<i className="keno-selection-mark" aria-hidden="true">●</i>}{hits.includes(n)&&<span aria-hidden="true">✓</span>}</button>)}</div>
        <div className="keno-legend"><span><i className="legend-selected"/>Selected</span><span><i className="legend-drawn"/>Drawn</span><span><i className="legend-hit"/>Match</span></div>
      </div><aside className="keno-machine-panel"><div className="keno-machine-title"><span>SERVER BALL REVEAL</span><strong>{open?'Waiting for the draw':`${count} of 20`}</strong></div><KenoMachine number={drawn.at(-1)??null} running={!!display?.outcome&&count<20}/><div className="keno-result" role="status">{count===20?(display?.ticket?`${hits.length} matches · ${display.ticket.payout===null?'Return pending':`${display.ticket.payout} credits returned`}`:'Draw complete'):count?`${count} of 20 balls revealed`:ticket?'Ticket confirmed. Waiting for the draw.':'Select your numbers before the countdown ends.'}</div></aside></div>
      <div className="keno-stake-panel"><div><label htmlFor="system-keno-stake">Bet amount per number</label><div className="keno-stake-row"><input id="system-keno-stake" inputMode="numeric" value={ticket?String(ticket.stakePerNumber):stakeText} onChange={e=>setStakeText(e.target.value)} disabled={locked}/><span>practice credits</span></div><p>Steps of 5 · Maximum 480 credits per ticket</p></div><div className="keno-ticket-summary"><span>TOTAL BET</span><strong>{cost} credits</strong><small>{picks.length} numbers × {shownStake||'—'} credits</small></div></div>
      <div className="keno-controls"><div><h2>{picks.length}/10 numbers selected</h2><p>{notice}</p><p className="keno-picks">{picks.join(' · ')||'Your selections appear here'}</p></div><div className="keno-actions"><button disabled={locked} onClick={()=>{if(round)setDraft({roundId:round.id,picks:drawKeno().slice(0,5).sort((a,b)=>a-b)});}}>Quick pick 5</button><button disabled={locked||!picks.length} onClick={()=>round&&setDraft({roundId:round.id,picks:[]})}>Clear</button><button className="keno-play" disabled={locked||!picks.length||!stake||cost>480||cost>(s?.balance??0)} onClick={()=>round&&submit({roundId:round.id,picks,stakePerNumber:stake})}>{ticket?'Ticket confirmed':`Confirm ticket · ${cost} credits`}</button></div></div>
      {pending&&!mutation.isPending&&<div className="px-6 pb-4"><button disabled={!connected} onClick={()=>submit(pending)}>Retry unconfirmed ticket</button></div>}
      <footer className="keno-footer"><details><summary>Rules & recent server draws</summary><p>Choose 1–10 numbers from 1–80. Each matching number returns 3.6× its stake, including the original stake on that number. Twenty different numbers are drawn. The 25% chance × 3.6× return gives 90% theoretical return over repeated play.</p><p>The server runs a new round every minute, including when nobody is watching. Entries close after 45 seconds. Refreshing or reconnecting restores your saved ticket and result. Tickets are never placed automatically. Group PVP uses separate rules and a 7% completion fee.</p><ol>{s?.rounds.filter(r=>r.outcome&&now>=r.endsAt-5000).map(r=><li key={r.id}><strong>{r.id}</strong> · {r.outcome!.join(', ')}{r.ticket&&` · Return ${r.ticket.payout??'pending'}`}</li>)}</ol></details></footer>
    </section>
  </div>;
}