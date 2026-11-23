import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
const mocks=vi.hoisted(()=>({send:vi.fn()}));
vi.mock('@/lib/api',()=>({api:{postDepositFunding:mocks.send}}));
vi.mock('@/providers/auth-provider',()=>({useAuth:()=>({user:{id:'synthetic-manager'}})}));
import {DepositFundingForm} from './deposit-funding-form';
afterEach(()=>{cleanup();sessionStorage.clear();mocks.send.mockReset();});
const mount=()=>render(<QueryClientProvider client={new QueryClient()}>
  <DepositFundingForm role="manager" targets={[{id:'test-agent',label:'Assigned Agent'}]}/>
</QueryClientProvider>);
it('requires confirmation and retries the same allocation after a lost reply and reload',async()=>{
  mocks.send.mockRejectedValueOnce(new Error('Lost response')).mockResolvedValueOnce({success:true});
  const form=mount();
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'test-agent'}});
  fireEvent.change(screen.getByLabelText('Amount in ETB'),{target:{value:'10000'}});
  expect(screen.getByRole('button',{name:'Allocate funds'})).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'Allocate funds'}));
  await screen.findByText('Lost response');
  form.unmount();
  mount();
  expect(screen.getByRole('button',{name:'Allocate funds'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Retry saved request'}));
  await waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(2));
  expect(mocks.send.mock.calls[0].slice(0,2)).toEqual(mocks.send.mock.calls[1].slice(0,2));
  expect(mocks.send.mock.calls[0][1]).toMatchObject({agentId:'test-agent',amountMinor:'1000000'});
});
