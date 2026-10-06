import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Archive, ArrowRight, MessageCircle, Search, Users } from 'lucide-react';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { boundedRequest } from '@/lib/bounded-request';

interface Room {id:string;name:string;isPrivate:boolean;closed:boolean;memberCount:number;lastMessage:string|null;lastType:string|null;lastMessageAt:string|null}
export function ChatInbox({selectedId}:{selectedId?:string}) {
  const {user}=useAuth();const [archived,setArchived]=useState(false);const [search,setSearch]=useState('');const [page,setPage]=useState(1);
  const query=useQuery({queryKey:['chat-inbox',user?.id,archived,search,page],enabled:!!user,
    queryFn:async({signal})=>unwrapData(await boundedRequest(s=>api.get<Room[]>('/groups/inbox',{archived,query:search,page},{signal:s}),signal)),refetchInterval:15000,retry:false});
  const rooms=query.data??[];
  return <aside className="flex h-full min-h-0 flex-col bg-white dark:bg-slate-950">
    <div className="p-5"><div className="flex items-center justify-between"><h1 className="text-2xl font-bold tracking-tight">Chats</h1><Link to="/groups" aria-label="Find or create a group" className="rounded-full bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-950"><Users size={20}/></Link></div>
      <p className="mt-1 text-xs text-slate-500">Good company. A little friendly competition.</p>
      <label className="mt-5 flex items-center gap-2 rounded-xl bg-slate-100 px-3 dark:bg-slate-900"><Search size={17} className="text-slate-400"/><input aria-label="Search chats" value={search} onChange={event=>{setSearch(event.target.value);setPage(1);}} placeholder="Search your conversations" className="w-full border-0 bg-transparent py-3 text-sm outline-none focus:ring-0"/></label>
      <div className="mt-4 flex gap-2">{[false,true].map(value=><button type="button" key={String(value)} aria-pressed={archived===value} onClick={()=>{setArchived(value);setPage(1);}} className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold ${archived===value?'bg-emerald-800 text-white':'bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300'}`}>{value?<Archive size={13}/>:<MessageCircle size={13}/>} {value?'Archived':'Active'}</button>)}</div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      {query.isPending&&<p role="status" className="p-5 text-sm text-slate-500">Loading conversations…</p>}
      {query.isError&&<button onClick={()=>void query.refetch()} className="p-5 text-sm text-red-600">Could not load chats. Try again.</button>}
      {!query.isPending&&!query.isError&&!rooms.length&&<div className="p-6 text-center text-sm text-slate-500"><MessageCircle className="mx-auto mb-3 opacity-40" size={32}/><p>{archived?'Archived and closed rooms appear here.':'Your next conversation starts with a group.'}</p><Link to="/groups" className="mt-4 inline-flex items-center gap-1 font-semibold text-emerald-700">Explore groups <ArrowRight size={14}/></Link></div>}
      {rooms.map(room=><Link key={room.id} to={`/messages/${room.id}`} className={`mb-1 flex items-center gap-3 rounded-2xl p-3 transition-colors ${room.id===selectedId?'bg-emerald-50 dark:bg-emerald-950/60':'hover:bg-slate-50 dark:hover:bg-slate-900'}`}><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-100 to-teal-200 text-lg font-bold text-emerald-900">{room.name.slice(0,1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-baseline justify-between gap-2"><h2 className="truncate text-sm font-bold">{room.name}</h2>{room.lastMessageAt&&<time className="shrink-0 text-[10px] text-slate-400">{new Date(room.lastMessageAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</time>}</div><p className="mt-1 truncate text-xs text-slate-500">{room.lastType==='VOICE'?'Voice message':room.lastType==='GIFT'?'A gift was shared':room.lastMessage||`${room.memberCount} members · Say hello`}</p><p className="mt-1 text-[10px] text-slate-400">{room.closed?'Closed · read-only':room.isPrivate?'Private group':'Public group'}</p></div></Link>)}
      <div className="flex justify-between px-3 text-xs">{page>1&&<button onClick={()=>setPage(page-1)}>Previous</button>}{rooms.length===30&&<button onClick={()=>setPage(page+1)}>More chats</button>}</div>
    </div>
  </aside>;
}
