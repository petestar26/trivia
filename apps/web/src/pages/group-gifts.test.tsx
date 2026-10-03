import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter,Route,Routes } from 'react-router-dom';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const send=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/api',()=>({api:{getGroupMembers:async()=>({data:[{user:{id:'recipient',username:'friend'},status:'ACTIVE'}]}),listGifts:async()=>({data:[{id:'gift',name:'Star',coinPrice:10,recipientPointValue:5}]}),sendGift:send}}));
vi.mock('@/providers/auth-provider',()=>({useAuth:()=>({user:{id:'owner'}})}));
import {GroupGiftsPage} from './group-gifts';
beforeEach(()=>{send.mockReset();sessionStorage.clear();});afterEach(cleanup);
async function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><MemoryRouter initialEntries={['/groups/group/gifts']}><Routes><Route path="/groups/:id/gifts" element={<GroupGiftsPage/>}/></Routes></MemoryRouter></QueryClientProvider>);await screen.findByRole('option',{name:'Star · 10 Coins'});fireEvent.change(screen.getByLabelText('Gift recipient'),{target:{value:'recipient'}});fireEvent.change(screen.getByLabelText('Gift'),{target:{value:'gift'}});}
it('unlocks the form after a definitive rejection',async()=>{
  send.mockRejectedValue(new Error(JSON.stringify({status:400,message:'Insufficient Coins'})));await mount();fireEvent.click(screen.getByRole('button',{name:'Confirm and send gift'}));
  await screen.findByText('Insufficient Coins');expect(screen.getByLabelText('Gift')).toBeEnabled();expect(sessionStorage.getItem('playqube.pending-gift.owner.group')).toBeNull();
});
it('retains the same receipt for an uncertain response and retries the same gift',async()=>{
  send.mockRejectedValue(new Error('network'));await mount();fireEvent.click(screen.getByRole('button',{name:'Confirm and send gift'}));
  fireEvent.click(await screen.findByRole('button',{name:'Retry pending gift'}));await waitFor(()=>expect(send).toHaveBeenCalledTimes(2));expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);expect(screen.getByLabelText('Gift')).toBeDisabled();
});

it.each([401,403,409,429])('keeps the receipt after an uncertain send and a %s retry rejection',async status=>{
  send.mockRejectedValueOnce(new Error('response lost')).mockRejectedValueOnce(new Error(JSON.stringify({status,message:'Retry later'}))).mockResolvedValueOnce({data:{isReplay:true}});
  await mount();fireEvent.click(screen.getByRole('button',{name:'Confirm and send gift'}));
  fireEvent.click(await screen.findByRole('button',{name:'Retry pending gift'}));await screen.findByText('Retry later');
  expect(sessionStorage.getItem('playqube.pending-gift.owner.group')).not.toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Retry pending gift'}));await screen.findByText('Gift sent. The recipient’s Game Points were credited.');
  expect(send.mock.calls).toHaveLength(3);expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);expect(send.mock.calls[2]).toEqual(send.mock.calls[0]);
});

it('does not let an old unmounted response erase a newer receipt',async()=>{
 let resolve!: (value:unknown)=>void;send.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await mount();fireEvent.click(screen.getByRole('button',{name:'Confirm and send gift'}));
 await waitFor(()=>expect(send).toHaveBeenCalledTimes(1));cleanup();
 const later={recipientId:'recipient',giftId:'gift',quantity:1,key:'newer-request'};sessionStorage.setItem('playqube.pending-gift.owner.group',JSON.stringify(later));
 resolve({data:{isReplay:false}});await new Promise(r=>setTimeout(r,10));expect(JSON.parse(sessionStorage.getItem('playqube.pending-gift.owner.group')!).key).toBe('newer-request');
});