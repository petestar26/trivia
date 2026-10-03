import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { GroupMemberInfo } from '@socialplay/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { GroupSocialNav } from '@/components/groups/group-social-nav';
import { Button } from '@/components/ui/button';
import { requestStatus } from '@/lib/request-error';
import { boundedRequest } from '@/lib/bounded-request';

interface Gift {id:string;name:string;coinPrice:number;recipientPointValue:number}
interface Attempt {recipientId:string;giftId:string;quantity:number;key:string}
export function GroupGiftsPage() {
  const {id}=useParams<{id:string}>();const {user}=useAuth();
  return id && user ? <Gifts key={`${id}:${user.id}`} groupId={id} userId={user.id}/> : null;
}
function Gifts({groupId,userId}:{groupId:string;userId:string}) {
  const cache=useQueryClient();const storageKey=`playqube.pending-gift.${userId}.${groupId}`;
  const [recipientId,setRecipient]=useState('');const [giftId,setGift]=useState('');const [notice,setNotice]=useState('');
  const [attempt,setAttempt]=useState<Attempt|null>(()=>{try{return JSON.parse(sessionStorage.getItem(storageKey)??'null');}catch{return null;}});
  const members=useQuery({queryKey:['group-gift-members',groupId,userId],queryFn:async()=>(await api.getGroupMembers(groupId)).data as GroupMemberInfo[]});
  const gifts=useQuery({queryKey:['gifts'],queryFn:async()=>(await api.listGifts()).data as Gift[],enabled:members.isSuccess});
  const mutation=useMutation({mutationFn:(a:Attempt)=>boundedRequest(()=>api.sendGift({recipientId:a.recipientId,giftId:a.giftId,quantity:1},a.key)),
    onSuccess:()=>{sessionStorage.removeItem(storageKey);setAttempt(null);setNotice('Gift sent. The recipient’s Game Points were credited.');void cache.invalidateQueries({queryKey:['wallet',userId]});},
    onError:(error)=>{const status=requestStatus(error);if(status===400){sessionStorage.removeItem(storageKey);setAttempt(null);}try{setNotice(JSON.parse((error as Error).message).message);}catch{setNotice('Could not confirm the gift. Retry the same request.');}}});
  const selected=gifts.data?.find(g=>g.id===(attempt?.giftId??giftId));
  const submit=()=>{let a=attempt;if(!a){a={recipientId,giftId,quantity:1,key:crypto.randomUUID()};try{sessionStorage.setItem(storageKey,JSON.stringify(a));}catch{setNotice('Unable to save a retry receipt. Gift was not sent.');return;}setAttempt(a);}mutation.mutate(a);};
  return <div className="mx-auto max-w-3xl space-y-5 p-4"><GroupSocialNav groupId={groupId}/><h1 className="text-3xl font-bold">Group gifts</h1><p className="text-sm text-gray-500">Send a gift to a member. Gifts spend Coins and award the listed Game Points.</p>
    {(members.isError||gifts.isError)?<p role="alert">Unable to load this group’s gifts.</p>:<div className="space-y-4 rounded-2xl border bg-white p-6 dark:bg-gray-900">
      <label className="block text-sm">Recipient<select aria-label="Gift recipient" className="mt-1 block w-full rounded-lg border bg-transparent p-3" value={attempt?.recipientId??recipientId} disabled={!!attempt||mutation.isPending} onChange={e=>setRecipient(e.target.value)}><option value="">Choose a member</option>{members.data?.filter(m=>m.status==='ACTIVE'&&m.user.id!==userId).map(m=><option key={m.user.id} value={m.user.id}>@{m.user.username}</option>)}</select></label>
      <label className="block text-sm">Gift<select aria-label="Gift" className="mt-1 block w-full rounded-lg border bg-transparent p-3" value={attempt?.giftId??giftId} disabled={!!attempt||mutation.isPending} onChange={e=>setGift(e.target.value)}><option value="">Choose a gift</option>{gifts.data?.map(g=><option key={g.id} value={g.id}>{g.name} · {g.coinPrice} Coins</option>)}</select></label>
      {selected&&<p className="rounded-xl bg-amber-50 p-3 text-amber-950">You spend {selected.coinPrice} Coins. The recipient receives {selected.recipientPointValue} Game Points.</p>}
      <Button disabled={mutation.isPending||(!attempt&&(!recipientId||!giftId))} onClick={submit}>{mutation.isPending?'Sending…':attempt?'Retry pending gift':'Confirm and send gift'}</Button>
    </div>}{notice&&<p role="status">{notice}</p>}</div>;
}