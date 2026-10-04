import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter,Route,Routes } from 'react-router-dom';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { GroupPvpSnapshot } from '@socialplay/shared';
const apiMock=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('@/lib/api',()=>({api:apiMock,unwrapData:(v:{data:unknown})=>v.data}));
vi.mock('@/providers/auth-provider',()=>({useAuth:()=>({user:{id:'owner'}})}));
import {GroupGamesPage} from './group-games';
let snapshot:GroupPvpSnapshot;
beforeEach(()=>{apiMock.get.mockReset();apiMock.post.mockReset();snapshot={enabled:true,currency:'GAME_POINTS',serverTime:Date.now(),groupName:'Friends',ownerId:'owner',balance:1000,
  round:{id:'round',creationRequestId:'request',game:'spin_win',entryAmount:100,policyId:'pvp-entry-fee7-v1',rulesId:'group-pvp-points-v1',state:'OPEN',expiresAt:Date.now()+900000,startsAt:null,outcome:null,settlement:null,entries:[]}};
  apiMock.get.mockImplementation(async()=>({data:structuredClone(snapshot)}));});
afterEach(cleanup);
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/groups/group/games']}><Routes><Route path="/groups/:id/games" element={<GroupGamesPage/>}/></Routes></MemoryRouter></QueryClientProvider>);}
it('shows the fee before confirmation and blocks owner start until everyone is ready',async()=>{
  snapshot.round!.entries=[{userId:'owner',username:'owner',ready:false,selection:null},{userId:'member',username:'member',ready:true,selection:[8]}];mount();
  expect(await screen.findByRole('button',{name:'Start 30-second countdown'})).toBeDisabled();
  expect(screen.getByText('Fee if completed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Number 7'}));apiMock.post.mockResolvedValue({data:{accepted:true}});
  fireEvent.click(screen.getByRole('button',{name:'Confirm 100 points · Ready'}));
  await waitFor(()=>expect(apiMock.post).toHaveBeenCalledWith('/groups/group/pvp/round/ready',{selection:[7],entryAmount:100,policyId:'pvp-entry-fee7-v1'},undefined,expect.objectContaining({signal:expect.any(AbortSignal)})));
});
it('releases a held POST when polling proves join succeeded',async()=>{
  apiMock.post.mockImplementation(()=>{snapshot.round!.entries=[{userId:'owner',username:'owner',ready:false,selection:null}];return new Promise(()=>{});});mount();
  fireEvent.click(await screen.findByRole('button',{name:'Join round'}));
  const confirm=await screen.findByRole('button',{name:'Confirm 100 points · Ready'},{timeout:3500});
  fireEvent.click(screen.getByRole('button',{name:'Number 7'}));expect(confirm).toBeEnabled();
  expect(screen.getByText('Confirmed by the server.')).toBeInTheDocument();
});
it('refreshes into the server countdown with entries locked and displays persisted winners',async()=>{
  snapshot.round!.state='COUNTDOWN';snapshot.round!.startsAt=snapshot.serverTime+30000;
  const view=mount();expect(await screen.findByRole('timer')).toHaveTextContent('30');expect(screen.queryByRole('button',{name:'Join round'})).toBeNull();view.unmount();
  snapshot.round!.state='SETTLED';snapshot.round!.outcome=[7];snapshot.round!.settlement={platformFee:14,prizes:[{userId:'owner',username:'owner',amount:186}],refunds:[],reason:null};
  mount();expect(await screen.findByText('Winners paid')).toBeInTheDocument();expect(screen.getByText('186 points returned')).toBeInTheDocument();
});

it('discloses a net loss when tied winners receive less than their entry',async()=>{
 snapshot.round!.state='SETTLED';snapshot.round!.outcome=[7];snapshot.round!.settlement={platformFee:14,prizes:[{userId:'owner',username:'owner',amount:93},{userId:'other',username:'other',amount:93}],refunds:[],reason:null};
 mount();expect(await screen.findAllByText('93 points returned')).toHaveLength(2);
 expect(screen.getAllByText('-7 net · 100 entry')).toHaveLength(2);
});
