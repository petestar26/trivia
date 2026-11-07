import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { CHAT_REACTIONS } from '@socialplay/shared';

const getGroupMessages = vi.fn();
const post = vi.fn();
const deleteMessage = vi.fn();
let roomClosed=false;
let canModerate=false;
const socketListeners=new Map<string,(event?:unknown)=>void>();
let testSocket:object|null=null;
let testUserId='me';

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

vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: testUserId } }) }));
vi.mock('@/components/voice/voice-message-player', () => ({ VoiceMessagePlayer: () => <div>Playable voice message</div> }));

import { MessagesPage, GroupRoundChat } from './messages';

// jsdom does not implement scrollIntoView (same reason setup.ts stubs
// matchMedia/localStorage). The page's auto-scroll effect calls it on every
// message change; without this the effect throws and masks what we're testing.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

it('loads embedded chat without scrolling the surrounding game or creating a financial action', async () => {
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
  getGroupMessages.mockResolvedValue({ data: [{ id:'arena-message',content:'Hello from the group',createdAt:'2026-11-06T00:00:00Z',sender:{id:'friend',username:'Tigist'} }] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter><GroupRoundChat groupId="group-1" userId="me" /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Hello from the group')).toBeVisible();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByText('Watch live')).not.toBeInTheDocument();
  client.clear();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  getGroupMessages.mockReset();
  post.mockReset();
  deleteMessage.mockReset();roomClosed=false;canModerate=false;
  testSocket=null;socketListeners.clear();
  testUserId='me';
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

    expect(await screen.findByText(/Messages could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
});

it('recovers a network failure with Retry without implying lost membership or sending a message', async () => {
  getGroupMessages.mockRejectedValue(new Error('network offline'));
  renderAtGroup();
  await screen.findByText('Messages could not be loaded. Check your connection and try again.');
  expect(screen.queryByText(/may not be a member/)).not.toBeInTheDocument();
  getGroupMessages.mockResolvedValue({
    data: [
      { id: 'recovered', content: 'Recovered conversation', createdAt: '2026-11-07T00:00:00Z' },
    ],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Recovered conversation')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});
it('hides cached history and disables sending after access is rejected, then restores after a successful retry', async () => {
  getGroupMessages.mockResolvedValue({
    data: [
      {
        id: 'private',
        content: 'Group-only message',
        createdAt: '2026-11-07T00:00:00Z',
        sender: { id: 'friend' },
      },
    ],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  renderAtGroup('group-1', client);
  await screen.findByText('Group-only message');
  fireEvent.click(screen.getByRole('button', { name: 'Reply to message' }));
  getGroupMessages.mockRejectedValue(new Error(JSON.stringify({ status: 403 })));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['messages'] });
  });
  await screen.findByText('This conversation is unavailable. Check your sign-in and group access.');
  expect(screen.queryByText('Group-only message')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel reply' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  getGroupMessages.mockResolvedValue({ data: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('No messages yet. Start the conversation!');
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  expect(post).not.toHaveBeenCalled();
  client.clear();
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
  expect(getGroupMessages).toHaveBeenCalledWith('group-1',{limit:50,latest:true,before:undefined},{signal:expect.any(AbortSignal)});
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
  let older=[row('old-1'),row('old-2'),row('old-3')];
  getGroupMessages.mockImplementation(async(_id,options)=>({data:options.before?older:latest}));
  testSocket={on:(name:string,fn:(value?:unknown)=>void)=>socketListeners.set(name,fn),
    off:(name:string)=>socketListeners.delete(name),emit:vi.fn()};
  renderAtGroup();fireEvent.click(await screen.findByRole('button',{name:'Load earlier messages'}));
  await screen.findByText('History old-1');
  const scroller=screen.getByText('History old-1').closest('.overflow-y-auto')!;
  Object.defineProperties(scroller,{scrollHeight:{value:2000},clientHeight:{value:500}});
  fireEvent.scroll(scroller,{target:{scrollTop:0}});
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
  older=older.filter(item=>item.id!=='old-2');
  act(()=>socketListeners.get('message:deleted')?.({messageId:'old-2'}));
  await waitFor(()=>expect(screen.queryByText('History old-2')).not.toBeInTheDocument());
  expect(screen.getByText('History old-1')).toBeInTheDocument();
  expect(screen.getByText('History old-3')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Load earlier messages'})).not.toBeInTheDocument();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  act(()=>socketListeners.get('message:deleted')?.({messageId:123}));
  expect(screen.getByText('History old-1')).toBeInTheDocument();
});

// Model the real cursor API so refetching across a moving latest-page boundary
// must derive the next cursor from the freshly fetched page, not a stale one.
function pagedHistory() {
  let rows = Array.from({ length: 103 }, (_, i) => ({
    id: `history-${i}`, content: `Message ${i}`, createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
    sender: { id: 'other', username: 'Friend' }, reactions: [] as { type: string; userId: string }[],
  }));
  getGroupMessages.mockImplementation(async (_id, options) => {
    const end = options.before ? rows.findIndex(row => row.id === options.before) : rows.length;
    if (end < 0) throw new Error('Stale cursor');
    return { data: structuredClone(rows.slice(Math.max(0, end - 50), end)) };
  });
  testSocket = { on: (name: string, fn: (value?: unknown) => void) => socketListeners.set(name, fn),
    off: (name: string) => socketListeners.delete(name), emit: vi.fn() };
  return { rows, remove: (id: string) => { rows = rows.filter(row => row.id !== id); } };
}
async function showAllHistory() {
  renderAtGroup();
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
  await screen.findByText('Message 3');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  await screen.findByText('Message 0');
}
it('reconciles edits and reactions on every loaded page without scrolling to the latest message', async () => {
  const server = pagedHistory();
  await showAllHistory();
  const scroller = screen.getByText('Message 0').closest('.overflow-y-auto')!;
  Object.defineProperties(scroller, { scrollHeight: { value: 6000 }, clientHeight: { value: 500 } });
  fireEvent.scroll(scroller, { target: { scrollTop: 100 } });
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
  server.rows[1].content = 'Corrected older message';
  act(() => socketListeners.get('message:updated')?.({ content: 'Untrusted event content' }));
  await screen.findByText('Corrected older message');
  expect(screen.queryByText('Message 1')).not.toBeInTheDocument();
  expect(screen.queryByText('Untrusted event content')).not.toBeInTheDocument();
  server.rows[1].reactions = [{ type: CHAT_REACTIONS[0].type, userId: 'me' }];
  act(() => socketListeners.get('reaction:added')?.());
  const article = screen.getByText('Corrected older message').closest('article')!;
  expect(await within(article).findByRole('button', { name: CHAT_REACTIONS[0].label })).toHaveAttribute('aria-pressed', 'true');
  server.rows[1].reactions = [];
  act(() => socketListeners.get('reaction:removed')?.());
  await waitFor(() => expect(within(article).queryByRole('button', { name: CHAT_REACTIONS[0].label })).not.toBeInTheDocument());
  expect(screen.getByText('Message 0')).toBeInTheDocument();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});
it('removes missed deletions after reconnect and fills the moving latest-page boundary', async () => {
  const server = pagedHistory();
  await showAllHistory();
  server.rows.push({ ...server.rows[102], id: 'new-after-disconnect', content: 'New while away' });
  server.remove('history-1');
  act(() => socketListeners.get('connect')?.());
  await screen.findByText('New while away');
  await waitFor(() => expect(screen.queryByText('Message 1')).not.toBeInTheDocument());
  for (const i of [0, 2, 3, 52, 53, 102]) expect(screen.getByText(`Message ${i}`)).toBeInTheDocument();
  expect(document.querySelectorAll('[data-message-id]')).toHaveLength(103);
});
it('leaves loaded history available when an older-page refresh fails and recovers on the next reconnect', async () => {
  const server = pagedHistory();
  await showAllHistory();
  const read = getGroupMessages.getMockImplementation()!;
  getGroupMessages.mockImplementation(async (...args) => {
    if (args[1].before) throw new Error('Temporarily unavailable');
    return read(...args);
  });
  act(() => socketListeners.get('connect')?.());
  await screen.findByText(/Connection interrupted. Showing saved messages/);
  expect(screen.getByText('Message 0')).toBeInTheDocument();
  server.remove('history-0');
  getGroupMessages.mockImplementation(read);
  act(() => socketListeners.get('connect')?.());
  await waitFor(() => expect(screen.queryByText('Message 0')).not.toBeInTheDocument());
  expect(screen.queryByText(/Connection interrupted. Showing saved messages/)).not.toBeInTheDocument();
  expect(screen.getByText('Message 2')).toBeInTheDocument();
});
it.each(['success', 'failure'])('cancels an older-page request on account change and ignores its late %s', async outcome => {
  const row = (id: string) => ({ id, content: id, createdAt: '2026-01-01T00:00:00Z', sender: { id: 'other' } });
  let finish!: (value: unknown) => void;
  let fail!: (reason: Error) => void;
  let signal!: AbortSignal;
  getGroupMessages.mockImplementation(async (_id, options, request) => {
    if (testUserId === 'second-account') return { data: [row('Second account history')] };
    if (!options.before) return { data: Array.from({ length: 50 }, (_, i) => row(`First account ${i}`)) };
    signal = request.signal;
    return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  });
  const page = renderAtGroup();
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
  await waitFor(() => expect(signal).toBeDefined());
  testUserId = 'second-account';
  page.rerender(<Routes><Route path="/messages/:groupId" element={<MessagesPage />} /></Routes>);
  await screen.findByText('Second account history');
  expect(signal.aborted).toBe(true);
  await act(async () => {
    if (outcome === 'success') finish({ data: [row('Private late first account history')] });
    else fail(new Error('Private late first account error'));
  });
  expect(screen.queryByText(/First account|Private late/)).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Second account history')).toBeInTheDocument();
});
