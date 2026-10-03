import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GROUP_PVP_RULES, quotePvpEntry, type GroupPvpGame, type GroupPvpSnapshot } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { SpinWinWheel } from '@/components/spin/spin-wheel';
import { GroupSocialNav } from '@/components/groups/group-social-nav';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';

interface Action { path:string; body:Record<string,unknown> }

function errorText(error: unknown) { try { return JSON.parse((error as Error).message).message ?? 'Please try again.'; } catch { return 'Please try again.'; } }
export function GroupGamesPage() {
  const { id } = useParams<{id:string}>(); const { user } = useAuth();
  return id && user ? <GroupGames key={`${id}:${user.id}`} groupId={id} userId={user.id}/> : null;
}
function GroupGames({groupId,userId}:{groupId:string;userId:string}) {
  const cache = useQueryClient();
  const endpoint = `/groups/${groupId}/pvp`;
  const queryKey = ['group-pvp',groupId,userId];
  const [clock,setClock] = useState(performance.now());
  const [game,setGame] = useState<GroupPvpGame>('spin_win');
  const [amount,setAmount] = useState('100');
  const [createId,setCreateId] = useState(()=>crypto.randomUUID());
  const [draft,setDraft] = useState<{roundId:string;picks:number[]}|null>(null);
  const [notice,setNotice] = useState('');
  const pendingRef=useRef<Action|null>(null);
  const [pendingAction,setPendingAction]=useState<Action|null>(null);
  useEffect(()=>()=>{pendingRef.current=null;},[]);
  const query = useQuery({queryKey,queryFn:async({signal})=>{
    const sentAt=performance.now();
    const snapshot=unwrapData(await boundedRequest(activeSignal=>api.get<GroupPvpSnapshot>(endpoint,undefined,{signal:activeSignal}),signal));
    return {snapshot,sentAt,receivedAt:performance.now()};
  },refetchInterval:1000,refetchOnWindowFocus:true,refetchOnReconnect:true,retry:false});
  useEffect(()=>{const timer=setInterval(()=>setClock(performance.now()),200);return()=>clearInterval(timer);},[]);
  const s=query.data?.snapshot; const r=s?.round;
  const age=query.data ? Math.max(clock,performance.now())-query.data.sentAt : Infinity;
  const connected=!!query.data && !query.isError && !query.isPaused && age<5000 && query.data.receivedAt-query.data.sentAt<2000;
  const now=s ? s.serverTime+age : 0;
  const mine=r?.entries.find(e=>e.userId===userId);
  const own=s?.ownerId===userId;
  const picks=mine?.ready ? mine.selection??[] : draft?.roundId===r?.id ? draft?.picks??[] : [];
  const open=connected && s?.enabled && r?.state==='OPEN' && now<r.expiresAt;
  const terminal=!r || r.state==='SETTLED' || r.state==='VOID';
  const quote=r ? quotePvpEntry(r.policyId,String(r.entryAmount)) : null;
  const clearPending=()=>{pendingRef.current=null;setPendingAction(null);};
  const mutation=useMutation({mutationFn:async({path,body}:Action)=>boundedRequest(signal=>api.post(path,body,undefined,{signal})),
    onSuccess:async(_data,action)=>{if(pendingRef.current!==action)return;clearPending();setNotice('Saved.');setCreateId(crypto.randomUUID());await cache.invalidateQueries({queryKey});await cache.invalidateQueries({queryKey:['wallet',userId]});},
    onError:async(error,action)=>{if(pendingRef.current!==action)return;const status=requestStatus(error);if(status>=400&&status<500&&status!==408)clearPending();setNotice(errorText(error));await cache.invalidateQueries({queryKey});}});
  useEffect(()=>{
    const action=pendingRef.current;if(!action||!r)return;
    const type=action.path.slice(action.path.lastIndexOf('/')+1);
    const sameRound=action.path.includes(`/${r.id}/`);
    const accepted=action.path===endpoint?r.creationRequestId===action.body.requestId:sameRound&&(
      type==='join'?!!mine:type==='ready'?!!mine?.ready:type==='withdraw'?!mine:
      type==='start'?['COUNTDOWN','DRAWN','SETTLED'].includes(r.state):type==='cancel'?r.state==='VOID':false);
    if(accepted){clearPending();mutation.reset();setNotice('Confirmed by the server.');void cache.invalidateQueries({queryKey:['wallet',userId]});}
  },[query.data,pendingAction]);
  const submit=(action:Action)=>{pendingRef.current=action;setPendingAction(action);mutation.mutate(action);};
  const busy=mutation.isPending || !!pendingAction || !connected;
  const act=(action:string)=>r && submit({path:`${endpoint}/${r.id}/${action}`,body:{}});
  const toggle=(number:number)=>{
    if(!r || !open || mine?.ready || busy)return;
    const max=r.game==='spin_win'?1:5;
    const next=picks.includes(number)?picks.filter(n=>n!==number):max===1?[number]:picks.length<max?[...picks,number]:picks;
    setDraft({roundId:r.id,picks:next});
  };
  if(query.isPending) return <p role="status" className="p-8">Loading group game room…</p>;
  if(!s) return <div className="p-6 space-y-4"><GroupSocialNav groupId={groupId}/><p role="alert">{query.error?errorText(query.error):'Game room unavailable.'}</p><Button onClick={()=>void query.refetch()}>Retry</Button></div>;
  const countdown=r?.startsAt ? Math.max(0,Math.ceil((r.startsAt-now)/1000)):0;
  const funded=r?.entries.filter(e=>e.ready).length??0;
  return <div className="mx-auto max-w-6xl space-y-5 p-4">
    <GroupSocialNav groupId={groupId}/>
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-[.25em] text-amber-600">{s.groupName}</p><h1 className="mt-1 text-3xl font-bold">Group game room</h1><p className="mt-2 text-sm text-gray-500">Play together. Confirm your entry. The owner starts the countdown.</p></div>
      <div className="rounded-2xl border bg-white px-5 py-3 dark:bg-gray-900"><span className="text-xs text-gray-500">Game Points</span><p className="text-2xl font-bold tabular-nums">{s.balance.toLocaleString()}</p></div>
    </header>
    <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">Game Points PVP · 7% completion fee · 93% prize pool · No Coins are spent or won.</p>
    {!connected && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-800">Reconnecting. Entries and start controls are paused until the server confirms this round.</p>}
    {terminal && own && s.enabled && <section className="rounded-2xl border bg-white p-5 dark:bg-gray-900">
      <h2 className="text-lg font-bold">Create a round</h2><div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">Game<select aria-label="Game" value={game} onChange={e=>setGame(e.target.value as GroupPvpGame)} className="rounded-lg border bg-transparent p-3"><option value="spin_win">Spin PVP</option><option value="turbo_keno">Keno PVP</option></select></label>
        <label className="flex flex-col gap-1 text-sm">Entry per player<input aria-label="Entry per player" inputMode="numeric" value={amount} onChange={e=>setAmount(e.target.value)} className="w-40 rounded-lg border bg-transparent p-3"/></label>
        <Button disabled={busy || !/^\d+$/.test(amount) || +amount<100 || +amount>10000 || +amount%100!==0} onClick={()=>submit({path:endpoint,body:{game,entryAmount:+amount,requestId:createId}})}>Create game</Button>
      </div><p className="mt-3 text-xs text-gray-500">100–10,000 points, in steps of 100. Everyone pays the same entry. Up to {GROUP_PVP_RULES.maxPlayers} players.</p>
    </section>}
    {!r && !own && <p className="rounded-2xl border p-8 text-center">Waiting for the group owner to create a game.</p>}
    {r && <section className="overflow-hidden rounded-3xl border border-amber-600/40 bg-[#082e29] text-[#fff7e4] shadow-xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-5"><div><p className="text-xs uppercase tracking-[.25em] text-amber-200">Player versus player</p><h2 className="text-2xl font-bold">{r.game==='spin_win'?'Spin PVP':'Keno PVP'}</h2></div><span className="rounded-full bg-white/10 px-4 py-2 text-sm">{r.state==='OPEN'?'Waiting for players':r.state==='COUNTDOWN'?'Entries locked':r.state==='DRAWN'?'Result saved · payout pending':r.state==='VOID'?'Refunded':'Paid'}</span></div>
      <div className="grid gap-6 p-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-5">
          {r.state==='COUNTDOWN' && <div role="timer" aria-label="Game starts in" className="rounded-2xl bg-black/20 p-6 text-center"><p className="text-sm text-emerald-100">Game starts in</p><p className="text-6xl font-black tabular-nums">{countdown}</p><p className="mt-2 text-xs">Your entry is locked. Everyone sees the same result.</p></div>}
          {r.outcome && <div className="rounded-2xl bg-black/20 p-5"><h3 className="mb-3 text-sm font-semibold text-amber-200">{r.game==='spin_win'?'Winning number':'Drawn numbers'}</h3><div className="flex flex-wrap gap-2">{r.outcome.map(n=><span key={n} className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-100 to-amber-500 text-xl font-black text-amber-950">{n}</span>)}</div></div>}
          {r.game==='spin_win' && !r.outcome && <div className="mx-auto max-w-xs"><SpinWinWheel rotation={0} spinning={r.state==='COUNTDOWN' && countdown===0}/></div>}
          {r.state==='OPEN' && <><p className="text-sm text-emerald-100">{r.game==='spin_win'?'Choose one number. Exact matches share the prize.':'Choose five numbers. The most matches win; tied players share the prize.'}</p><div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10">{Array.from({length:r.game==='spin_win'?37:80},(_,i)=>i+(r.game==='spin_win'?0:1)).map(n=><button key={n} aria-pressed={picks.includes(n)} aria-label={`Number ${n}`} disabled={!open || !!mine?.ready || busy} onClick={()=>toggle(n)} className={`min-h-10 rounded-lg border text-sm font-bold ${picks.includes(n)?'border-amber-100 bg-amber-300 text-amber-950':'border-white/15 bg-white/5 hover:bg-white/15'} disabled:cursor-not-allowed`}>{n}</button>)}</div></>}
          {mine?.ready && <p className="rounded-xl bg-emerald-900/60 p-3 text-sm">Your confirmed numbers: {mine.selection?.join(', ')}</p>}
          {r.settlement && <div role="status" className="rounded-2xl border border-amber-300/30 bg-black/15 p-5"><h3 className="text-xl font-bold">{r.state==='VOID'?'Full refunds completed':'Winners paid'}</h3>{r.settlement.prizes.map(w=><p key={w.userId} className="mt-3 flex justify-between gap-3"><span>@{w.username}</span><strong>+{w.amount.toLocaleString()} points</strong></p>)}{r.state==='VOID' && <p className="mt-2 text-sm">{r.settlement.reason==='NO_WINNER'?'Nobody matched the winning result.':'This round was cancelled or expired.'} Every confirmed entry was returned. No fee was charged.</p>}<p className="mt-3 text-xs text-emerald-100">Platform fee: {r.settlement.platformFee} points</p></div>}
        </div>
        <aside className="space-y-4">
          <div className="rounded-2xl bg-black/20 p-5"><p className="text-xs uppercase tracking-widest text-emerald-100/70">Confirmed prize pool</p><p className="mt-2 text-4xl font-bold text-amber-200">{(funded*Number(quote!.prizeContribution)).toLocaleString()}</p><p className="mt-1 text-xs">Game Points · after the 7% completion fee</p><dl className="mt-5 space-y-2 text-sm"><div className="flex justify-between"><dt>Your entry</dt><dd>{r.entryAmount}</dd></div><div className="flex justify-between"><dt>Fee if completed</dt><dd>{quote!.platformFee}</dd></div><div className="flex justify-between"><dt>To the prize pool</dt><dd>{quote!.prizeContribution}</dd></div></dl></div>
          <div className="rounded-2xl bg-black/20 p-5"><h3 className="font-bold">Players · {funded}/{r.entries.length} ready</h3><ul className="mt-3 space-y-3">{r.entries.map(e=><li key={e.userId} className="flex justify-between gap-2 text-sm"><span className="truncate">@{e.username}</span><span className={e.ready?'text-emerald-300':'text-amber-200'}>{e.ready?'Ready':'Choosing'}</span></li>)}</ul></div>
          {open && !mine && <Button className="w-full" disabled={busy} onClick={()=>act('join')}>Join round</Button>}
          {open && mine && !mine.ready && <Button className="w-full" disabled={busy || picks.length!==(r.game==='spin_win'?1:5) || s.balance<r.entryAmount} onClick={()=>submit({path:`${endpoint}/${r.id}/ready`,body:{selection:picks,entryAmount:r.entryAmount,policyId:r.policyId}})}>Confirm {r.entryAmount} points · Ready</Button>}
          {open && mine && <Button variant="outline" className="w-full bg-transparent text-white" disabled={busy} onClick={()=>act('withdraw')}>{mine.ready?'Leave and refund entry':'Leave round'}</Button>}
          {open && own && <><Button className="w-full bg-amber-300 text-amber-950 hover:bg-amber-200" disabled={busy || r.entries.length<2 || funded!==r.entries.length} onClick={()=>act('start')}>Start 30-second countdown</Button><Button variant="ghost" className="w-full text-emerald-100" disabled={busy} onClick={()=>act('cancel')}>Cancel round · full refunds</Button></>}
          <p className="text-xs leading-relaxed text-emerald-100/70">The owner can start once every joined player confirms. No entries or cancellations after start. No winner means a full refund. The lobby expires after 15 minutes.</p>
        </aside>
      </div>
    </section>}
    {notice && <p role="status" className="rounded-xl border p-3 text-sm">{notice}</p>}
    {pendingAction&&!mutation.isPending&&<Button disabled={!connected} onClick={()=>submit(pendingAction)}>Retry unconfirmed action</Button>}
    <Link className="text-sm text-primary-600" to={`/messages/${groupId}`}>Return to group chat</Link>
  </div>;
}
