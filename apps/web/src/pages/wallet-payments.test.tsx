import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('@/lib/api',()=>({api:m,unwrapData:(r:{data:unknown})=>r.data}));
vi.mock('@/providers/auth-provider',()=>({useAuth:()=>({user:{id:'customer'}})}));
import {WalletPaymentsPage} from './wallet-payments';
import {WalletOperationsPage} from './wallet-operations';
const options={countries:[{id:'country',name:'Test country',currencyCode:'USD'}],agents:[{id:'agent',countryId:'country',displayName:'Approved agent',minOrderAmount:1,maxOrderAmount:1000,paymentAccounts:[{id:'account',methodDef:{name:'Bank transfer'}}]}],isAgent:false,isAdmin:false};
beforeEach(()=>{sessionStorage.clear();m.post.mockReset();m.get.mockReset();m.get.mockImplementation(async(path:string)=>({data:path==='/wallet/payment-options'?options:path==='/withdrawals/payout-accounts'?[{id:'payout',countryId:'country',status:'ACTIVE',displayLabel:'My account',accountDetails:{number:'****1234'}}]:[]}));});
afterEach(cleanup);
function mount(section='deposit'){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><MemoryRouter initialEntries={['/wallet/'+section]}><Routes><Route path="/wallet/operations" element={<WalletOperationsPage/>}/><Route path="/wallet/:section" element={<WalletPaymentsPage/>}/></Routes></MemoryRouter></QueryClientProvider>);}
it('requires country, agent, approved method and confirmation before an idempotent deposit',async()=>{
 mount();fireEvent.change(await screen.findByLabelText('Country'),{target:{value:'country'}});
 fireEvent.change(screen.getByLabelText('Amount to pay · USD'),{target:{value:'100'}});
 fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'agent'}});
 fireEvent.change(screen.getByLabelText('Payment method'),{target:{value:'account'}});
 const button=screen.getByRole('button',{name:'Create deposit request'});expect(button).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox'));m.post.mockResolvedValue({success:true,data:{id:'order'}});fireEvent.click(button);
 await waitFor(()=>expect(m.post).toHaveBeenCalledTimes(1));expect(m.post.mock.calls[0][0]).toBe('/agent-orders');
 expect(m.post.mock.calls[0][1]).toMatchObject({agentId:'agent',countryId:'country',paymentAccountId:'account',fiatAmount:10000,idempotencyKey:expect.any(String)});
 await waitFor(()=>expect(button).toBeDisabled());
});
it('uses the server quote and only IDs when confirming a withdrawal',async()=>{
 mount('withdraw');fireEvent.change(await screen.findByLabelText('Country'),{target:{value:'country'}});
 fireEvent.change(screen.getByLabelText('Coins to withdraw'),{target:{value:'100'}});
 fireEvent.change(screen.getByLabelText('Payout account'),{target:{value:'payout'}});
 m.post.mockResolvedValueOnce({data:{id:'quote',coinAmount:100,fiatAmount:'25',fiatCurrency:'USD',expiresAt:new Date(Date.now()+300000).toISOString()}}).mockResolvedValue({success:true});
 fireEvent.click(screen.getByRole('button',{name:'Get withdrawal quote'}));await screen.findByText('100 Coins → 0.25 USD');
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm withdrawal'}));
 await waitFor(()=>expect(m.post).toHaveBeenCalledTimes(2));expect(m.post.mock.calls[1][1]).toEqual({quoteId:'quote',payoutAccountId:'payout',idempotencyKey:expect.any(String)});
});
it('shows disabled-country empty state without inventing payment availability',async()=>{
 m.get.mockImplementation(async(path:string)=>({data:path==='/wallet/payment-options'?{...options,countries:[],agents:[]}:[]}));mount();
 expect(await screen.findByText(/No payment countries are enabled/)).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Create deposit request'})).not.toBeInTheDocument();
});
it('does not load privileged queues for an ordinary customer',async()=>{
 mount('operations');await screen.findByText('Processing access required');expect(m.get.mock.calls.every(([p])=>p==='/wallet/payment-options')).toBe(true);
});
it('loads the assigned payout details and requires evidence before recording a transfer',async()=>{
 const row={id:'withdrawal-one',status:'PAYOUT_IN_PROGRESS',coinAmount:100,fiatAmount:'25',fiatCurrency:'USD',createdAt:new Date().toISOString(),paymentSnapshot:{bank:'Test bank'}};
 m.get.mockImplementation(async(path:string)=>{if(path==='/withdrawals/withdrawal-one') throw Object.assign(new Error('Forbidden owner-only route'),{status:403});return ({data:path==='/wallet/payment-options'?{...options,isAgent:true}:path==='/withdrawals/agent/assigned'?[row]:path==='/withdrawals/agent/assigned/withdrawal-one'?row:[]});});
 m.post.mockResolvedValue({success:true});mount('operations');fireEvent.click(await screen.findByRole('button',{name:'Record completed transfer'}));
 await waitFor(()=>expect(m.get).toHaveBeenCalledWith('/withdrawals/agent/assigned/withdrawal-one'));
 const button=screen.getByRole('button',{name:'Confirm action'});expect(button).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Transfer reference'),{target:{value:'bank-ref-123'}});
 fireEvent.change(screen.getByLabelText('Evidence and decision notes'),{target:{value:'Transfer checked against bank receipt'}});
 fireEvent.click(screen.getByRole('checkbox'));await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
 await waitFor(()=>expect(m.post).toHaveBeenCalledTimes(1));expect(m.post.mock.calls[0][0]).toBe('/withdrawals/withdrawal-one/submit-payment');expect(m.post.mock.calls[0][1]).toMatchObject({referenceNumber:'bank-ref-123',note:'Transfer checked against bank receipt',idempotencyKey:expect.any(String)});
});
it('keeps resolution disabled when the underlying financial request cannot be loaded',async()=>{
 m.get.mockImplementation(async(path:string)=>{
  if(path==='/withdrawals/admin/disputes/dispute-one')throw new Error('Offline');
  return {data:path==='/wallet/payment-options'?{...options,isAdmin:true}:path==='/withdrawals/admin/disputes'?[{id:'dispute-one',status:'ASSIGNED',reason:'OTHER',description:'Investigate',withdrawalId:'withdrawal-one'}]:[]};
 });mount('operations');fireEvent.click(await screen.findByRole('button',{name:'Review resolution'}));await screen.findByText(/Request details could not load/);
 fireEvent.change(screen.getByLabelText('Outcome'),{target:{value:'CANCELLED'}});fireEvent.change(screen.getByLabelText('Evidence and decision notes'),{target:{value:'Review note'}});fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByRole('button',{name:'Confirm action'})).toBeDisabled();expect(m.post).not.toHaveBeenCalled();
});
it('shows all requested crypto assets as unavailable without payment controls',async()=>{
 const assets=['USDT','USDC','BTC','ETH','SOL'].map(symbol=>({symbol,name:symbol,network:'Network pending',available:false,reason:'Provider integration pending'}));
 m.get.mockImplementation(async(path:string)=>({data:path==='/wallet/payment-options'?{...options,countries:[],crypto:{assets}}:[]}));mount();
 await screen.findByRole('heading',{name:'Crypto deposits'});for(const asset of assets)expect(screen.getByRole('heading',{name:`${asset.name} · ${asset.symbol}`})).toBeInTheDocument();expect(m.post).not.toHaveBeenCalled();
});
