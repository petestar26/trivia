import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {SystemKenoSnapshot} from '@socialplay/shared';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('@/lib/api',()=>({api:mocks,unwrapData:(v:{data:unknown})=>v.data}));
vi.mock('@/providers/auth-provider',()=>({useAuth:()=>({user:{id:'tester'}})}));
vi.mock('@/components/casino/CasinoProvider',()=>({useCasino:()=>({coinsBalance:88,walletLoading:false,walletError:false})}));
import {SystemKenoPage} from './keno-system';
let s:SystemKenoSnapshot;
beforeEach(()=>{mocks.get.mockReset();mocks.post.mockReset();const now=Date.now();s={enabled:true,serverTime:now,balance:1000,rounds:[{id:'minute',opensAt:now-5000,closesAt:now+40000,endsAt:now+55000,outcome:null,ticket:null}]};mocks.get.mockImplementation(async()=>({data:structuredClone(s)}));});
afterEach(cleanup);
function mount(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><MemoryRouter><SystemKenoPage/></MemoryRouter></QueryClientProvider>);}
it('uses the server countdown and confirms the explicit stake once',async()=>{
 mount();expect(await screen.findByRole('timer',{name:'Betting closes in'})).toHaveTextContent('40s');fireEvent.click(screen.getByRole('button',{name:'Number 7'}));fireEvent.change(screen.getByLabelText('Bet amount per number'),{target:{value:'10'}});
 mocks.post.mockImplementation(async()=>{s.balance=990;s.rounds[0].ticket={picks:[7],stakePerNumber:10,stake:10,payout:null};return {data:{accepted:true}};});
 fireEvent.click(screen.getByRole('button',{name:'Confirm ticket · 10 credits'}));await waitFor(()=>expect(mocks.post).toHaveBeenCalledTimes(1));
 expect(await screen.findByRole('button',{name:'Ticket confirmed'})).toBeDisabled();expect(screen.getByRole('button',{name:'Number 7'})).toBeDisabled();expect(screen.getByText('88 Coins')).toBeInTheDocument();
});
it('polling recovers a held confirmation, and refresh restores its persisted result',async()=>{
 mocks.post.mockImplementation(()=>{s.rounds[0].ticket={picks:[7],stakePerNumber:5,stake:5,payout:null};return new Promise(()=>{});});
 const view=mount();await screen.findByRole('timer',{name:'Betting closes in'});fireEvent.click(screen.getByRole('button',{name:'Number 7'}));fireEvent.click(screen.getByRole('button',{name:'Confirm ticket · 5 credits'}));
 expect(await screen.findByText('Confirmed by the server. Your ticket is saved.',{},{timeout:3500})).toBeInTheDocument();view.unmount();
 s.serverTime=s.rounds[0].endsAt-2000;s.rounds[0].outcome=Array.from({length:20},(_,i)=>i+1);s.rounds[0].ticket!.payout=18;s.balance=1013;
 mount();expect(await screen.findByText('1 matches · 18 credits returned')).toBeInTheDocument();expect(screen.getByRole('timer',{name:'Next round in'})).toHaveTextContent('2s');expect(mocks.post).toHaveBeenCalledTimes(1);
});
it('disables entry on a failed server refresh',async()=>{
 mount();await screen.findByRole('timer',{name:'Betting closes in'});mocks.get.mockRejectedValue(new Error('offline'));
 await screen.findByRole('alert',{}, {timeout:3500});expect(screen.getByRole('button',{name:'Number 7'})).toBeDisabled();
});
it.each([403,404])('shows an unavailable table for HTTP %s',async(status)=>{
 mocks.get.mockRejectedValue(new Error(JSON.stringify({status})));
 mount();
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('This Keno table is currently unavailable'));
 expect(screen.getByRole('button',{name:'Number 7'})).toBeDisabled();
});
