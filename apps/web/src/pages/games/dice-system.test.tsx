import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {SystemDiceSnapshot} from '@socialplay/shared';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('@/lib/api',()=>({api:mocks,unwrapData:(v:{data:unknown})=>v.data}));
vi.mock('@/providers/auth-provider',()=>({useAuth:()=>({user:{id:'dice-tester'}})}));
vi.mock('@/components/casino/CasinoProvider',()=>({useCasino:()=>({coinsBalance:88,walletLoading:false,walletError:false})}));
import {SystemDicePage,dicePendingKey} from './dice-system';
let s:SystemDiceSnapshot;
beforeEach(()=>{sessionStorage.clear();mocks.get.mockReset();mocks.post.mockReset();const now=Date.now();s={enabled:true,rulesId:'dice-sum7-practice90-v1',serverTime:now,balance:1000,rounds:[{id:'dice-minute-1',opensAt:now-5000,closesAt:now+40000,endsAt:now+55000,outcome:null,ticket:null}]};mocks.get.mockImplementation(async()=>({data:structuredClone(s)}));});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function mount(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><MemoryRouter><SystemDicePage/></MemoryRouter></QueryClientProvider>);}
it('shows the corrected return and explicit amount, then confirms one server ticket',async()=>{
 mount();expect(await screen.findByRole('timer',{name:'Betting closes in'})).toHaveTextContent('40s');
 expect(screen.getByText('54 credits')).toBeInTheDocument();expect(screen.getByText('88 Coins')).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('Bet amount'),{target:{value:'70'}});expect(screen.getByText('108 credits')).toBeInTheDocument();
 mocks.post.mockImplementation(async()=>{s.balance=930;s.rounds[0].ticket={stake:70,payout:null};return {data:{accepted:true}};});
 fireEvent.click(screen.getByRole('button',{name:'Confirm ticket · 70 credits'}));await waitFor(()=>expect(mocks.post).toHaveBeenCalledTimes(1));
 expect(mocks.post.mock.calls[0].slice(0,2)).toEqual(['/games/system-dice/tickets',{roundId:'dice-minute-1',stake:70}]);
 expect(await screen.findByRole('button',{name:'Ticket confirmed'})).toBeDisabled();expect(screen.getByLabelText('Bet amount')).toBeDisabled();
 expect(sessionStorage.getItem(dicePendingKey('dice-tester'))).toBeNull();
});
it('rejects non-step, fractional and oversized amounts without truncating',async()=>{
 mount();await screen.findByRole('timer',{name:'Betting closes in'});
 for(const value of ['50','70.5','525','0','']){fireEvent.change(screen.getByLabelText('Bet amount'),{target:{value}});expect(screen.getByRole('button',{name:/Confirm ticket/})).toBeDisabled();}
 expect(mocks.post).not.toHaveBeenCalled();
});
it('persists a lost-response ticket across remount and retries only its original amount',async()=>{
 mocks.post.mockRejectedValueOnce(new TypeError('offline'));const view=mount();await screen.findByRole('timer',{name:'Betting closes in'});
 fireEvent.click(screen.getByRole('button',{name:'Confirm ticket · 35 credits'}));await screen.findByRole('button',{name:'Retry saved ticket · 35 credits'});
 expect(sessionStorage.getItem(dicePendingKey('dice-tester'))).toBe(JSON.stringify({roundId:'dice-minute-1',stake:35}));view.unmount();
 mount();await screen.findByRole('button',{name:'Retry saved ticket · 35 credits'});expect(mocks.post).toHaveBeenCalledTimes(1);expect(screen.getByLabelText('Bet amount')).toBeDisabled();
 mocks.post.mockImplementationOnce(async()=>{s.rounds[0].ticket={stake:35,payout:null};s.balance=965;return {data:{accepted:true,isReplay:true}};});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Retry saved ticket · 35 credits'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'Retry saved ticket · 35 credits'}));await screen.findByRole('button',{name:'Ticket confirmed'});
 expect(mocks.post.mock.calls[1][1]).toEqual(mocks.post.mock.calls[0][1]);expect(sessionStorage.getItem(dicePendingKey('dice-tester'))).toBeNull();
});
it('polling confirms a ticket whose response never arrives without resubmitting',async()=>{
 mocks.post.mockImplementation(()=>{s.rounds[0].ticket={stake:35,payout:null};s.balance=965;return new Promise(()=>{});});
 mount();await screen.findByRole('timer',{name:'Betting closes in'});fireEvent.click(screen.getByRole('button',{name:'Confirm ticket · 35 credits'}));
 expect(await screen.findByText('Confirmed by the server. Your ticket is saved.',{},{timeout:3500})).toBeInTheDocument();expect(mocks.post).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem(dicePendingKey('dice-tester'))).toBeNull();
});
it('restores the saved winning dice and return after refresh without another play',async()=>{
 s.serverTime=s.rounds[0].endsAt-2000;s.rounds[0].outcome=[2,6];s.rounds[0].ticket={stake:35,payout:54};s.balance=1019;
 mount();expect(await screen.findByText('54 practice credits returned')).toBeInTheDocument();expect(screen.getByRole('timer',{name:'Next round in'})).toHaveTextContent('2s');
 expect(screen.getByRole('img',{name:'Die 2'})).toBeInTheDocument();expect(screen.getByRole('img',{name:'Die 6'})).toBeInTheDocument();expect(mocks.post).not.toHaveBeenCalled();
});
it('pauses entry on a failed snapshot and resumes from server time',async()=>{
 mount();await screen.findByRole('timer',{name:'Betting closes in'});mocks.get.mockRejectedValue(new Error('offline'));
 await screen.findByText('Reconnecting. Entry is paused until a fresh server update arrives.',{}, {timeout:3500});expect(screen.getByRole('button',{name:/Confirm ticket/})).toBeDisabled();
 s.serverTime+=10000;mocks.get.mockImplementation(async()=>({data:structuredClone(s)}));
 await waitFor(()=>expect(screen.getByRole('button',{name:/Confirm ticket/})).toBeEnabled(),{timeout:3500});expect(screen.getByRole('timer',{name:'Betting closes in'})).toHaveTextContent('30s');
});
it('a refreshed countdown follows the existing round instead of restarting',async()=>{
 const view=mount();expect(await screen.findByRole('timer',{name:'Betting closes in'})).toHaveTextContent('40s');view.unmount();s.serverTime+=15000;
 mount();expect(await screen.findByRole('timer',{name:'Betting closes in'})).toHaveTextContent('25s');expect(mocks.post).not.toHaveBeenCalled();
});
it('does not send if the pending receipt cannot be saved',async()=>{
 mount();await screen.findByRole('timer',{name:'Betting closes in'});vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('full');});
 fireEvent.click(screen.getByRole('button',{name:'Confirm ticket · 35 credits'}));expect(await screen.findByText('Enable browser storage before confirming. No new ticket was sent.')).toBeInTheDocument();expect(mocks.post).not.toHaveBeenCalled();
});
it('blocks an unavailable rules version and an unaffordable ticket',async()=>{
 s.balance=20;mount();await screen.findByRole('timer',{name:'Betting closes in'});expect(screen.getByRole('button',{name:/Confirm ticket/})).toBeDisabled();expect(screen.getByText('Not enough practice credits for this amount.')).toBeInTheDocument();
 cleanup();s.balance=1000;s.rulesId='unknown';mount();await screen.findByRole('timer',{name:'Next round in'});expect(screen.getByRole('button',{name:/Confirm ticket/})).toBeDisabled();
});
