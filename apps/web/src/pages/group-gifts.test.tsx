import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GIFT_COLLECTION_POLICY } from '@socialplay/shared';
const mocks = vi.hoisted(() => ({ send: vi.fn(), get: vi.fn(), closed: false }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, postWithIdempotency: mocks.send,
  getGroupMembers: async () => ({ data: [{ user: { id: 'recipient', username: 'friend' }, status: 'ACTIVE' }] }) },
  unwrapData: (r: {data:unknown}) => r.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/components/groups/group-lifecycle', () => ({ GroupLifecycle: () => null, useGroupLifecycle: () => ({closed:mocks.closed}) }));
import { GroupGiftsPage } from './group-gifts';
const heart = { id:'golden-heart',name:'Golden Heart',emoji:'💛',description:'A thank-you',theme:'amber',faceValue:100 };
const snapshot = () => ({ policyId:GIFT_COLLECTION_POLICY,balance:1000,catalog:[heart],owned:[],totalOwned:0,page:1,pageSize:12 });
const success = { success:true,data:{kind:'BUY',amount:100,fee:0,gift:{recipientUsername:'friend'},messageId:null} };
beforeEach(() => { mocks.closed=false; mocks.send.mockReset(); mocks.get.mockReset(); mocks.get.mockResolvedValue({data:snapshot()}); sessionStorage.clear(); });
afterEach(cleanup);
async function mount() {
  const view=render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{retry:false}}})}><MemoryRouter initialEntries={['/groups/group/gifts']}><Routes><Route path="/groups/:id/gifts" element={<GroupGiftsPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
  await screen.findByRole('button',{name:'Choose Golden Heart',hidden:true});return view;
}
async function select() { await mount();fireEvent.click(screen.getByRole('button',{name:'Choose Golden Heart'}));await screen.findByRole('dialog'); }
it('discloses zero buy fee and 90 point conversion return before spending',async()=>{
  await select();const dialog=screen.getByRole('dialog');expect(within(dialog).getByText('Purchase fee (0%)')).toBeInTheDocument();
  expect(within(dialog).getByText(/convert this gift for 90 points/)).toBeInTheDocument();expect(mocks.send).not.toHaveBeenCalled();
  mocks.send.mockResolvedValue(success);fireEvent.click(within(dialog).getByRole('button',{name:'Confirm purchase · 100 points'}));
  await screen.findByText('Gift added to your collection. No purchase fee.');expect(mocks.send.mock.calls[0][2]).toMatchObject({kind:'BUY',faceValue:100,policyId:GIFT_COLLECTION_POLICY});
});
it('prevents an unaffordable purchase in the UI',async()=>{
  mocks.get.mockResolvedValue({data:{...snapshot(),balance:10}});await select();expect(screen.getByText('You need 90 more Game Points.')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Confirm purchase · 100 points'})).toBeDisabled();
});
it('discloses the conversion fee and exact return with explicit confirmation',async()=>{
  mocks.get.mockResolvedValue({data:{...snapshot(),owned:[{...heart,id:'owned-gift',catalogId:heart.id,version:2}],totalOwned:1}});
  await mount();fireEvent.click(screen.getByRole('tab',{name:'My gifts (1)'}));fireEvent.click(screen.getByRole('button',{name:'Convert'}));
  expect(await screen.findByText('Conversion fee (10%)')).toBeInTheDocument();expect(screen.getByText('90 points',{exact:true})).toBeInTheDocument();expect(mocks.send).not.toHaveBeenCalled();
  mocks.send.mockResolvedValue({success:true,data:{kind:'CONVERT',amount:90,fee:10,gift:{},messageId:null}});
  fireEvent.click(screen.getByRole('button',{name:'Confirm conversion'}));await screen.findByText('Gift converted. 90 Game Points added. Fee: 10 points.');
  expect(mocks.send.mock.calls[0][2]).toMatchObject({kind:'CONVERT',version:2,faceValue:100});
});
it('unlocks a definitive rejected purchase without retaining a stale receipt',async()=>{
  mocks.send.mockRejectedValue(new Error(JSON.stringify({status:400,message:'Insufficient Game Points'})));await select();fireEvent.click(screen.getByRole('button',{name:'Confirm purchase · 100 points'}));
  await screen.findByText('Insufficient Game Points');expect(sessionStorage.getItem('playqube.pending-collectible.owner')).toBeNull();expect(screen.getByLabelText('Gift recipient')).toBeEnabled();
});
it('retains the exact request through an uncertain response and remount',async()=>{
  mocks.send.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(success);await select();fireEvent.click(screen.getByRole('button',{name:'Confirm purchase · 100 points'}));
  await screen.findByRole('button',{name:'Retry pending gift'});const first=mocks.send.mock.calls[0];cleanup();await mount();
  fireEvent.click(screen.getByRole('button',{name:'Retry pending gift'}));await screen.findByText('Gift added to your collection. No purchase fee.');expect(mocks.send.mock.calls[1]).toEqual(first);
});
it.each([401,403,409,429])('preserves an uncertain receipt after a %s response',async status=>{
  mocks.send.mockRejectedValue(new Error(JSON.stringify({status,message:'Try later'})));await select();fireEvent.click(screen.getByRole('button',{name:'Confirm purchase · 100 points'}));
  await screen.findByText('Try later');expect(sessionStorage.getItem('playqube.pending-collectible.owner')).not.toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Retry pending gift'}));await waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(2));expect(mocks.send.mock.calls[0]).toEqual(mocks.send.mock.calls[1]);
});
it('allows closing a pending request while keeping its safe retry available',async()=>{
  mocks.send.mockRejectedValue(new Error('offline'));await select();fireEvent.click(screen.getByRole('button',{name:'Confirm purchase · 100 points'}));
  await screen.findByRole('button',{name:'Retry pending gift'});fireEvent.click(screen.getByRole('button',{name:'Close gift details'}));
  expect(await screen.findByRole('button',{name:'Resume pending gift'})).toBeInTheDocument();expect(sessionStorage.getItem('playqube.pending-collectible.owner')).not.toBeNull();
});
it('does not let an unmounted response erase a newer receipt',async()=>{
  let resolve!: (value:unknown)=>void;mocks.send.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await select();fireEvent.click(screen.getByRole('button',{name:'Confirm purchase · 100 points'}));
  await waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(1));cleanup();const newer={...JSON.parse(sessionStorage.getItem('playqube.pending-collectible.owner')!),key:'newer-request'};
  sessionStorage.setItem('playqube.pending-collectible.owner',JSON.stringify(newer));resolve(success);await new Promise(r=>setTimeout(r,10));
  expect(JSON.parse(sessionStorage.getItem('playqube.pending-collectible.owner')!).key).toBe('newer-request');
});

it('keeps owned gifts convertible after room closure while blocking new group gifts',async()=>{
  mocks.closed=true;
  mocks.get.mockResolvedValue({data:{...snapshot(),owned:[{...heart,id:'owned-gift',catalogId:heart.id,version:2}],totalOwned:1}});
  await mount();expect(screen.getByRole('button',{name:'Choose Golden Heart'})).toBeDisabled();
  fireEvent.click(screen.getByRole('tab',{name:'My gifts (1)'}));
  expect(screen.getByRole('button',{name:/^Send$/})).toBeDisabled();
  expect(screen.getByRole('button',{name:/^Convert$/})).toBeEnabled();
});
