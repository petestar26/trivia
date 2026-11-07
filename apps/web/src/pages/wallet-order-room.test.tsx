import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: m, unwrapData: (r: { data: unknown }) => r.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'member' } }) }));
import { WalletOrderRoomPage, type PaymentRoom } from './wallet-order-room';
const id = '11111111-1111-4111-8111-111111111111';
let room: PaymentRoom;
beforeEach(() => {
  sessionStorage.clear();
  m.get.mockReset();
  m.post.mockReset();
  room = {
    id,
    number: 'DEP-20261107-001',
    kind: 'deposit',
    role: 'member',
    status: 'CREATED',
    coinAmount: 50000,
    fiatAmount: '50000',
    fiatCurrency: 'ETB',
    pricingSnapshot: { minorDigits: 2, feeMinor: 0 },
    paymentSnapshot: { accountNumber: 'TEST-12345', accountName: 'Abebe' },
    createdAt: new Date().toISOString(),
    serverNow: new Date().toISOString(),
    deadline: new Date(Date.now() + 600000).toISOString(),
    confirmationDeadline: null,
    memberName: 'Dawit',
    agentName: 'Abebe',
    hold: { status: 'ACTIVE', amount: 50000 },
    submission: null,
    appeals: [],
    recovery: null,
    messages: [],
    nextCursor: null,
    actions: {
      markPaid: true,
      release: false,
      cancel: true,
      claim: false,
      submitPayout: false,
      confirmReceipt: false,
      appeal: true,
      latePayment: false,
      message: true,
    },
  };
  m.get.mockImplementation(async () => ({ data: structuredClone(room) }));
  m.post.mockResolvedValue({ success: true, data: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/wallet/orders/${room.kind}/${id}`]}>
        <Routes>
          <Route path="/wallet/orders/:kind/:id" element={<WalletOrderRoomPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...view, client };
}
it.each([
  ['deposit', 'member'],
  ['deposit', 'agent'],
  ['withdrawal', 'member'],
  ['withdrawal', 'agent'],
] as const)(
  'lets the %s %s appeal with explicit consent and keeps failed input',
  async (kind, role) => {
    room.kind = kind;
    room.role = role;
    room.status = kind === 'deposit' ? 'CREATED' : 'HELD';
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open appeal' }));
    fireEvent.change(screen.getByLabelText('Describe the issue'), {
      target: { value: 'Transfer is delayed; please investigate.' },
    });
    const button = screen.getByRole('button', { name: 'Confirm action' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    m.post.mockRejectedValueOnce(
      new Error(JSON.stringify({ status: 409, message: 'The order changed.' }))
    );
    fireEvent.click(button);
    await screen.findByText('The order changed.');
    expect(screen.getByLabelText('Describe the issue')).toHaveValue(
      'Transfer is delayed; please investigate.'
    );
    expect(m.post.mock.calls[0][0]).toBe(
      kind === 'deposit' ? '/agent-disputes' : `/withdrawals/${id}/appeal`
    );
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByLabelText('Describe the issue')).toBeNull());
  }
);
it('requires actual receipt confirmation before the agent can release a deposit', async () => {
  room.role = 'agent';
  room.status = 'PAYMENT_SUBMITTED';
  room.actions = { ...room.actions, markPaid: false, cancel: false, release: true };
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Payment verified · release ETB' }));
  expect(screen.getByText(/screenshot or message alone/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm action' })).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText('I received the full amount in my bank or mobile-money account.')
  );
  fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }));
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
  expect(m.post.mock.calls[0][0]).toBe(`/agent-orders/${id}/settle`);
  expect(screen.getByRole('link', { name: 'Back to payments' })).toHaveAttribute(
    'href',
    '/agent/operations'
  );
});
it('refreshing into an appeal prevents a previously selected release and shows the decision record', async () => {
  room.role = 'agent';
  room.status = 'PAYMENT_SUBMITTED';
  room.actions.release = true;
  const { client } = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Payment verified · release ETB' }));
  fireEvent.click(screen.getByRole('checkbox'));
  room.status = 'DISPUTE';
  room.actions.release = false;
  room.actions.appeal = false;
  room.appeals = [
    {
      id: 'appeal',
      reason: 'OTHER',
      description: 'Investigate the receipt',
      status: 'ASSIGNED',
      openedAt: new Date().toISOString(),
      resolutionNote: null,
    },
  ];
  await client.invalidateQueries({ queryKey: ['payments'] });
  await screen.findByText('Appeal in progress');
  expect(screen.getByRole('button', { name: 'Confirm action' })).toBeDisabled();
  expect(screen.getByText('Investigate the receipt')).toBeInTheDocument();
  expect(m.post).not.toHaveBeenCalled();
});
it('keeps an uncertain message request and retries its original key once without resending edited content', async () => {
  mount();
  await screen.findByText('DEP-20261107-001');
  fireEvent.change(screen.getByLabelText('Message'), {
    target: { value: 'Please verify transfer 123.' },
  });
  m.post.mockRejectedValueOnce(new Error('Connection lost'));
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await screen.findByText('Connection lost');
  const original = m.post.mock.calls[0].slice(0, 2);
  expect(screen.getByLabelText('Message')).toHaveValue('Please verify transfer 123.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved request' }));
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  expect(m.post.mock.calls[1].slice(0, 2)).toEqual(original);
});
it('disables money actions on a failed refresh and never treats it as an empty order', async () => {
  const { client } = mount();
  await screen.findByText('DEP-20261107-001');
  m.get.mockRejectedValue(new Error('unavailable'));
  await client.invalidateQueries({ queryKey: ['payments'] });
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'I have sent the payment' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Open appeal' })).toBeDisabled();
  expect(screen.getByText('DEP-20261107-001')).toBeInTheDocument();
});
it('keeps appeals available when an unpaid deposit deadline passes and refuses unsupported receipt files', async () => {
  room.deadline = new Date(Date.now() - 60000).toISOString();
  mount();
  await screen.findByText('Payment deadline reached', { exact: false });
  expect(screen.queryByRole('button', { name: 'I have sent the payment' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Open appeal' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Attach receipt'), {
    target: { files: [new File(['<svg>'], 'bad.svg', { type: 'image/svg+xml' })] },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Use a PNG, JPEG or WebP receipt up to 2 MB.'
  );
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
});
it('denies an unreadable room without showing payment details or mutation controls', async () => {
  m.get.mockRejectedValue(new Error('Forbidden'));
  mount();
  await screen.findByRole('alert');
  expect(screen.queryByText('TEST-12345')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open appeal' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
});
it('preserves previously read messages when a busy order rolls into another fifty-message page', async () => {
  const message = (n: number) => ({
    id: String(n).padStart(4, '0'),
    role: 'member',
    mine: true,
    body: `Payment note ${n}`,
    createdAt: new Date(1794000000000 + n * 1000).toISOString(),
    attachment: null,
  });
  room.messages = Array.from({ length: 50 }, (_, i) => message(i + 2));
  room.nextCursor = '0002';
  m.get.mockImplementation(async (path: string) => ({
    data: path.includes('?before=')
      ? { ...room, messages: [message(1)], nextCursor: null }
      : structuredClone(room),
  }));
  const { client } = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Load older messages' }));
  await screen.findByText('Payment note 1', { exact: true });
  room.messages = Array.from({ length: 50 }, (_, i) => message(i + 52));
  room.nextCursor = '0052';
  await client.invalidateQueries({ queryKey: ['payments'] });
  await screen.findByText('Payment note 101', { exact: true });
  for (const n of [1, 2, 50, 51, 52, 101])
    expect(screen.getByText(`Payment note ${n}`, { exact: true })).toBeInTheDocument();
});
