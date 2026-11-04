import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,it,expect,vi} from 'vitest';
const {get}=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('@/lib/api',()=>({api:{get},unwrapData:(r:any)=>r.data}));
vi.mock('@/providers/auth-provider',()=>({useAuth:()=>({user:{id:'member'}})}));
import {PracticeWalletPage} from './practice-wallet';
afterEach(()=>{cleanup();get.mockReset();});
function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><MemoryRouter><PracticeWalletPage/></MemoryRouter></QueryClientProvider>);}
it('shows an isolated gift balance and no deposit or withdrawal action',async()=>{
 get.mockResolvedValue({data:{balance:9500}});mount();expect(await screen.findByText('9,500')).toBeInTheDocument();
 expect(get).toHaveBeenCalledWith('/gift-collection');expect(screen.getByText(/virtual ETB with no cash value/)).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'Open gift shop'})).toHaveAttribute('href','/gifts');expect(screen.queryByRole('button',{name:/deposit|withdraw/i})).toBeNull();
});
it('shows unavailable instead of inventing a zero balance and supports retry',async()=>{
 get.mockRejectedValueOnce(Error('offline')).mockResolvedValue({data:{balance:10000}});mount();await screen.findByRole('alert');
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));expect(await screen.findByText('10,000')).toBeInTheDocument();
});
