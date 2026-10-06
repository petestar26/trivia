import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const getGroupMessages = vi.fn();
const post = vi.fn();
const deleteMessage = vi.fn();
let roomClosed=false;
let canModerate=false;
const socketListeners=new Map<string,(event?:unknown)=>void>();
let testSocket:object|null=null;

vi.mock('@/lib/api', () => ({
  unwrapData: (value:any)=>value.data,
  api: {
    getGroupMessages: (...a: unknown[]) => getGroupMessages(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => deleteMessage(...a),
    get: async(path:string)=>({success:true,data:path.endsWith('/lifecycle')?{name:'Test room',serverTime:Date.now(),expiresAt:Date.now()+(roomClosed?-1000:86400000),closed:roomClosed,archived:false,canModerate}:[]}),
  },
}));
// Opt in to a controlled socket for deletion-event/history regressions.
vi.mock('@/providers/socket-provider', () => ({
  useSocket: () => ({ socket: testSocket, isConnected: !!testSocket }),
}));

vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('@/components/voice/voice-message-player', () => ({ VoiceMessagePlayer: () => <div>Playable voice message</div> }));

import { MessagesPage } from './messages';

// jsdom does not implement scrollIntoView (same reason setup.ts stubs
// matchMedia/localStorage). The page's auto-scroll effect calls it on every
// message change; without this the effect throws and masks what we're testing.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  getGroupMessages.mockReset();
  post.mockReset();
  deleteMessage.mockReset();roomClosed=false;canModerate=false;
  testSocket=null;socketListeners.clear();
});

function renderAtGroup(groupId = 'group-1', client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/messages/${groupId}`]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    <Routes>
      <Route path="/messages/:groupId" element={<MessagesPage />} />
    </Routes>,
    { wrapper },
  );
}

describe('MessagesPage', () => {
  // Regression, two defects at once:
  //  1. `useMutation` used to sit *after* the !groupId / isLoading / isError
  //     early returns, so the loading render skipped it and the loaded render
  //     called it. The hook count changed between renders and React threw
  //     error #310 ("Rendered more hooks than during the previous render"),
  //     crashing the page to a blank screen.
  //  2. The query already resolves to the message array, but the page then
  //     unwrapped `.data` off it again — so even without the crash the list
  //     would have rendered permanently empty.
  // Resolving asynchronously is essential: it forces the real
  // loading -> loaded transition that triggered the hook-order crash.
  it('survives the loading -> loaded transition and renders messages', async () => {
    getGroupMessages.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                success: true,
                data: [
                  {
                    id: 'msg-1',
                    content: 'staging smoke test message',
                    createdAt: new Date('2026-09-07T06:00:00Z').toISOString(),
                    sender: { displayName: 'Staging Smoke Test', username: 'sp_smoketest' },
                  },
                ],
              }),
            0,
          ),
        ),
    );

    renderAtGroup();

    // Loaded render: content present, no crash, and the composer is usable.
    expect(await screen.findByText('staging smoke test message')).toBeInTheDocument();
    expect(screen.getByText('Staging Smoke Test')).toBeInTheDocument();
    expect(screen.queryByText('No messages yet. Start the conversation!')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type a message…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('shows the empty state when the group genuinely has no messages', async () => {
    getGroupMessages.mockResolvedValue({ success: true, data: [] });

    renderAtGroup();

    expect(await screen.findByText('No messages yet. Start the conversation!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('surfaces the error state without crashing', async () => {
    getGroupMessages.mockRejectedValue(new Error('forbidden'));

    renderAtGroup();

    expect(await screen.findByText(/Failed to load messages/)).toBeInTheDocument();
  });
});

describe('MessagesPage — send progression invalidation', () => {
  it('invalidates progression caches on successful message send, preserving the messages refresh', async () => {
    getGroupMessages.mockResolvedValue({ success: true, data: [] });
    post.mockResolvedValue({ success: true });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderAtGroup('group-1', client);

    await screen.findByRole('button', { name: 'Send' });
    fireEvent.change(screen.getByPlaceholderText('Type a message…'), { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['messages', 'group-1'] }))
    );
    // invalidateProgressionQueries effects.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['achievements'] }))
    );
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['progress'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
  });

  it('does NOT invalidate progression caches when the send fails', async () => {
    getGroupMessages.mockResolvedValue({ success: true, data: [] });
    post.mockRejectedValue(new Error('fail'));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderAtGroup('group-1', client);

    await screen.findByRole('button', { name: 'Send' });
    fireEvent.change(screen.getByPlaceholderText('Type a message…'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // onSuccess never runs, so neither the messages refresh nor any
    // progression surface is invalidated.
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['messages', 'group-1'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['achievements'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['progress'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
  });
});


it('renders lowercase voice messages from the real API serializer', async () => {
  getGroupMessages.mockResolvedValue({ data: [{ id:'voice',content:'',type:'voice',createdAt:'2026-10-03T00:00:00Z',voiceMessage:{duration:12} }] });
  renderAtGroup();expect(await screen.findByText('Playable voice message')).toBeInTheDocument();
});
it('renders authoritative gift cards alongside free reactions and requests latest messages', async () => {
  getGroupMessages.mockResolvedValue({ data: [{ id:'gift',content:'Gift sent',type:'gift',createdAt:'2026-10-03T00:00:00Z',sender:{id:'friend',username:'friend'},gift:{name:'Golden Heart',emoji:'💛',theme:'amber',recipientId:'me',recipientUsername:'me',faceValue:100} }] });
  renderAtGroup();expect(await screen.findByText('Gift delivered')).toBeInTheDocument();expect(screen.getByText('Golden Heart')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Add reaction'}));
  expect(screen.getByRole('button',{name:'Love'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'Open gifts'})).toBeInTheDocument();
  expect(getGroupMessages).toHaveBeenCalledWith('group-1',{limit:50,latest:true});
});

it('retains a newer draft while an earlier message is sending',async()=>{
  getGroupMessages.mockResolvedValue({data:[]});let finish!:(value:unknown)=>void;post.mockImplementation(()=>new Promise(resolve=>finish=resolve));renderAtGroup();
  const input=await screen.findByPlaceholderText('Type a message…');await waitFor(()=>expect(input).not.toBeDisabled());
  fireEvent.change(input,{target:{value:'First'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));await waitFor(()=>expect(post).toHaveBeenCalledOnce());
  fireEvent.change(input,{target:{value:'Second'}});finish({success:true});await waitFor(()=>expect(input).toHaveValue('Second'));
});
it('retries an unconfirmed message with its original receipt',async()=>{
  getGroupMessages.mockResolvedValue({data:[]});post.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({success:true});renderAtGroup();
  const input=await screen.findByPlaceholderText('Type a message…');await waitFor(()=>expect(input).not.toBeDisabled());
  fireEvent.change(input,{target:{value:'Send once'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));
  fireEvent.click(await screen.findByRole('button',{name:'Retry message'}));await waitFor(()=>expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0][1]).toEqual(post.mock.calls[1][1]);expect(post.mock.calls[0][1].clientRequestId).toBeTruthy();
});

describe('closed chat moderation',()=>{
  it('completes a hide retry after the first success response was lost',async()=>{
    roomClosed=true;canModerate=true;
    let rows=[{id:'hidden-1',content:'Unconfirmed hide',createdAt:new Date().toISOString(),sender:{id:'other'}}];
    getGroupMessages.mockImplementation(async()=>({data:rows}));
    deleteMessage.mockImplementationOnce(async()=>{rows=[];throw new Error('Response lost');})
      .mockRejectedValueOnce(new Error(JSON.stringify({status:404})));
    renderAtGroup();fireEvent.click(await screen.findByRole('button',{name:'Hide message'}));
    fireEvent.click(screen.getByRole('button',{name:'Hide for everyone'}));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button',{name:'Hide for everyone'}));
    await waitFor(()=>expect(deleteMessage).toHaveBeenCalledTimes(2));
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Unconfirmed hide')).not.toBeInTheDocument();
    expect(getGroupMessages.mock.calls.length).toBeGreaterThan(1);
  });
  it('keeps a genuine permission failure visible without removing the message',async()=>{
    roomClosed=true;canModerate=true;
    getGroupMessages.mockResolvedValue({data:[{id:'denied-1',content:'Still visible',createdAt:new Date().toISOString(),sender:{id:'other'}}]});
    deleteMessage.mockRejectedValue(new Error(JSON.stringify({status:403})));
    renderAtGroup();fireEvent.click(await screen.findByRole('button',{name:'Hide message'}));
    fireEvent.click(screen.getByRole('button',{name:'Hide for everyone'}));
    await screen.findByRole('alert');expect(screen.getByText('Still visible')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('lets an owner hide a message with confirmation while keeping the composer closed',async()=>{
    roomClosed=true;canModerate=true;
    let rows=[{id:'abuse-1',content:'Moderation example',createdAt:new Date().toISOString(),sender:{id:'other',username:'other'}}];
    getGroupMessages.mockImplementation(async()=>({success:true,data:rows}));
    deleteMessage.mockImplementation(async()=>{rows=[];return {success:true};});
    renderAtGroup();
    fireEvent.click(await screen.findByRole('button',{name:'Hide message'}));
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Type a message…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Hide for everyone'}));
    await waitFor(()=>expect(deleteMessage).toHaveBeenCalledWith('/groups/group-1/messages/abuse-1'));
    await waitFor(()=>expect(screen.queryByText('Moderation example')).not.toBeInTheDocument());
  });
  it('keeps hide controls out of a regular member’s closed history',async()=>{
    roomClosed=true;
    getGroupMessages.mockResolvedValue({success:true,data:[{id:'own-1',content:'Saved history',createdAt:new Date().toISOString(),sender:{id:'me'}}]});
    renderAtGroup();await screen.findByText('Saved history');
    expect(screen.queryByRole('button',{name:'Hide message'})).not.toBeInTheDocument();
  });
});

it('removes only the deleted older message and preserves the reader’s loaded history',async()=>{
  const row=(id:string)=>({id,content:`History ${id}`,createdAt:'2026-10-03T00:00:00Z',sender:{id:'other'}});
  const latest=Array.from({length:50},(_,i)=>row(`new-${i}`));
  const older=[row('old-1'),row('old-2'),row('old-3')];
  getGroupMessages.mockImplementation(async(_id,options)=>({data:options.before?older:latest}));
  testSocket={on:(name:string,fn:(value?:unknown)=>void)=>socketListeners.set(name,fn),
    off:(name:string)=>socketListeners.delete(name),emit:vi.fn()};
  renderAtGroup();fireEvent.click(await screen.findByRole('button',{name:'Load earlier messages'}));
  await screen.findByText('History old-1');
  const scroller=screen.getByText('History old-1').closest('.overflow-y-auto')!;
  Object.defineProperties(scroller,{scrollHeight:{value:2000},clientHeight:{value:500}});
  fireEvent.scroll(scroller,{target:{scrollTop:0}});
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
  act(()=>socketListeners.get('message:deleted')?.({messageId:'old-2'}));
  await waitFor(()=>expect(screen.queryByText('History old-2')).not.toBeInTheDocument());
  expect(screen.getByText('History old-1')).toBeInTheDocument();
  expect(screen.getByText('History old-3')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Load earlier messages'})).not.toBeInTheDocument();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  act(()=>socketListeners.get('message:deleted')?.({messageId:123}));
  expect(screen.getByText('History old-1')).toBeInTheDocument();
});
