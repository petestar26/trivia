import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({post:vi.fn(),remove:vi.fn()}));
vi.mock('@/lib/api',()=>({api:{post:mocks.post,delete:mocks.remove}}));
import { MessageReactions } from './message-reactions';
beforeEach(()=>{mocks.post.mockReset();mocks.remove.mockReset();mocks.post.mockResolvedValue({success:true});mocks.remove.mockResolvedValue({success:true});});afterEach(cleanup);
function mount(reactions:{userId:string;type:string}[]=[]){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><MessageReactions groupId="g" messageId="m" userId="me" reactions={reactions}/></QueryClientProvider>);}
it('shows six free reactions and sends the selected desired state',async()=>{
 mount();expect(screen.getAllByRole('button')).toHaveLength(6);fireEvent.click(screen.getByRole('button',{name:'Love'}));await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith('/groups/g/messages/m/reactions',{type:'LOVE'}));
});
it('removes only the signed-in user’s existing reaction',async()=>{
 mount([{userId:'me',type:'LIKE'},{userId:'friend',type:'LIKE'}]);expect(screen.getByRole('button',{name:'Like'})).toHaveAttribute('aria-pressed','true');fireEvent.click(screen.getByRole('button',{name:'Like'}));await waitFor(()=>expect(mocks.remove).toHaveBeenCalledWith('/groups/g/messages/m/reactions/LIKE'));
});
it('shows errors without inventing a successful reaction',async()=>{
 mocks.post.mockRejectedValue(new Error('offline'));mount();fireEvent.click(screen.getByRole('button',{name:'Wow'}));await screen.findByText('Could not confirm your reaction. Refreshing…');expect(screen.getByRole('button',{name:'Wow'})).toHaveAttribute('aria-pressed','false');
});
