import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
const m=vi.hoisted(()=>({post:vi.fn()}));
vi.mock('@/lib/api',()=>({api:m}));
vi.mock('@/providers/auth-provider',()=>({useAuth:()=>({user:{id:'wallet-test'}})}));
import {useWalletAction,validWalletAction} from './use-wallet-action';
const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
beforeEach(()=>{sessionStorage.clear();m.post.mockReset();});afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('preserves the exact request and key across an uncertain response and remount',async()=>{
 m.post.mockRejectedValueOnce(new Error('offline'));let view=renderHook(()=>useWalletAction(),{wrapper});
 await act(()=>view.result.current.run('/agent-orders',{fiatAmount:100}));
 const first=m.post.mock.calls[0].slice(0,2);expect(view.result.current.pending).not.toBeNull();view.unmount();
 view=renderHook(()=>useWalletAction(),{wrapper});m.post.mockResolvedValueOnce({success:true});
 await act(()=>view.result.current.run('/agent-orders',{fiatAmount:999}));
 expect(m.post.mock.calls[1].slice(0,2)).toEqual(first);expect(view.result.current.pending).toBeNull();
 expect(sessionStorage.getItem('playqube.wallet-pending.wallet-test')).toBeNull();
});
it('deduplicates rapid clicks while the request is in flight',async()=>{
 let finish!:(v:unknown)=>void;m.post.mockImplementation(()=>new Promise(r=>finish=r));
 const view=renderHook(()=>useWalletAction(),{wrapper});let request!:Promise<void>;
 act(()=>{request=view.result.current.run('/withdrawals',{quoteId:'q'});void view.result.current.run('/withdrawals',{quoteId:'q'});});
 await waitFor(()=>expect(m.post).toHaveBeenCalledTimes(1));await act(async()=>{finish({success:true});await request;});
});
it('does not submit without durable storage',async()=>{
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('storage unavailable');});const v=renderHook(()=>useWalletAction(),{wrapper});
 await act(()=>v.result.current.run('/agent-orders',{}));expect(m.post).not.toHaveBeenCalled();expect(v.result.current.message).toContain('No request was sent');
});
it('clears a definitively rejected request and rejects unrelated stored endpoints',async()=>{
 m.post.mockRejectedValue(new Error(JSON.stringify({status:403,message:'Not eligible'})));const v=renderHook(()=>useWalletAction(),{wrapper});
 await act(()=>v.result.current.run('/withdrawals',{}));expect(v.result.current.pending).toBeNull();expect(v.result.current.message).toBe('Not eligible');
 expect(validWalletAction({path:'https://example.test',body:{idempotencyKey:'12345678'}})).toBe(false);
 expect(validWalletAction({path:'/auth/login',body:{idempotencyKey:'12345678'}})).toBe(false);
});
