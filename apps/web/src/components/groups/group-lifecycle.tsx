import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Clock3 } from 'lucide-react';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { boundedRequest } from '@/lib/bounded-request';

interface Lifecycle {name:string;expiresAt:number;serverTime:number;closed:boolean;archived:boolean;canModerate?:boolean}
export function useGroupLifecycle(groupId?:string) {
  const {user}=useAuth();
  const [clock,setClock]=useState(performance.now());
  const query=useQuery({queryKey:['group-lifecycle',groupId,user?.id],enabled:!!groupId&&!!user,
    queryFn:async({signal})=>{const sentAt=performance.now();return {data:unwrapData(await boundedRequest(s=>api.get<Lifecycle>(`/groups/${groupId}/lifecycle`,undefined,{signal:s}),signal)),sentAt};},
    refetchInterval:15000,refetchOnReconnect:true,retry:false});
  useEffect(()=>{const id=setInterval(()=>setClock(performance.now()),1000);return()=>clearInterval(id);},[]);
  const data=query.data?.data;
  const remaining=data?Math.max(0,Math.ceil((data.expiresAt-data.serverTime-(clock-query.data!.sentAt))/1000)):0;
  return {query,data,remaining,closed:!!data&&(data.closed||remaining===0),canWrite:!!data&&!query.isError&&!data.closed&&remaining>0};
}
export function GroupLifecycle({groupId}:{groupId:string}) {
  const {data,remaining,closed,query}=useGroupLifecycle(groupId);const cache=useQueryClient();
  const archive=useMutation({mutationFn:()=>boundedRequest(signal=>api.post(`/groups/${groupId}/archive`,{archived:!data?.archived},undefined,{signal})),onSuccess:()=>{void cache.invalidateQueries({queryKey:['group-lifecycle',groupId]});void cache.invalidateQueries({queryKey:['chat-inbox']});}});
  const countdown=`${Math.floor(remaining/3600).toString().padStart(2,'0')}:${Math.floor(remaining%3600/60).toString().padStart(2,'0')}:${(remaining%60).toString().padStart(2,'0')}`;
  return <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
    <span className="inline-flex items-center gap-1.5"><Clock3 size={14}/>{!data?(query.isError?'Connection unavailable':'Checking room…'):closed?'Room closed · conversation and results saved':<>Room closes in <span role="timer" aria-label="Group closes in" className="font-semibold tabular-nums">{countdown}</span></>}</span>
    {data&&<button type="button" onClick={()=>archive.mutate()} disabled={archive.isPending} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"><Archive size={14}/>{data.archived?'Unarchive for me':'Archive for me'}</button>}
    {archive.isError&&<span role="alert">Could not update your archive. Try again.</span>}
  </div>;
}
