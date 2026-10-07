import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), role: 'ADMIN' }));
vi.mock('@/lib/api', () => ({ api: m, unwrapData: (r: { data: unknown }) => r.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'admin', role: m.role } }) }));
import { LatePaymentCases, LatePaymentReport } from './wallet-late-payments';
const item = {
  id: 'case',
  orderId: 'order',
  status: 'ASSIGNED',
  assignedAdminId: 'admin',
  paymentReference: 'IN123',
  paidAmount: 500,
  paidAt: '2020-01-01T00:00:00Z',
  description: 'Paid late',
  order: { orderNumber: 'AG-123', fiatCurrency: 'ETB' },
};
beforeEach(() => {
  m.role = 'ADMIN';
  sessionStorage.clear();
  m.get.mockReset();
  m.post.mockReset();
  m.get.mockImplementation((path: string) => Promise.resolve({data: path === '/workspaces/access' ? {role: m.role} : [item]}));
  m.post.mockResolvedValue({ data: {} });
});
afterEach(cleanup);
function mount(component: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>{component}</MemoryRouter>
    </QueryClientProvider>
  );
}
it.each([
  ['ETB', '5.25', 525],
  ['JPY', '525', 525],
  ['KWD', '5.251', 5251],
] as const)(
  'reports exact %s minor units without client status or credit fields',
  async (currency, amount, minor) => {
    mount(<LatePaymentReport orderId="order" currency={currency} />);
    fireEvent.click(screen.getByRole('button', { name: 'Already paid? Report transfer' }));
    const submit = screen.getByRole('button', { name: 'Submit recovery report' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Transfer reference'), { target: { value: 'IN123' } });
    fireEvent.change(screen.getByLabelText(`Amount sent (${currency})`), {
      target: { value: amount },
    });
    fireEvent.change(screen.getByLabelText('Transfer time (local)'), {
      target: { value: '2020-01-02T12:30' },
    });
    fireEvent.change(screen.getByLabelText('Details'), {
      target: { value: 'Transfer after closure' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(m.post).toHaveBeenCalledOnce());
    expect(m.post.mock.calls[0][0]).toBe('/late-payments');
    expect(m.post.mock.calls[0][1]).toEqual({
      orderId: 'order',
      paymentReference: 'IN123',
      paidAmount: minor,
      paidAt: new Date('2020-01-02T12:30').toISOString(),
      description: 'Transfer after closure',
      idempotencyKey: expect.any(String),
    });
  }
);
async function fillRefund(currency = 'ETB', amount = '5.00') {
  m.get.mockResolvedValue({
    data: [{ ...item, order: { ...item.order, fiatCurrency: currency } }],
  });
  mount(<LatePaymentCases admin />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record verified refund' }));
  for (const [label, value] of [
    ['Verified incoming reference', 'IN123'],
    [`Verified amount received and fully refunded (${currency})`, amount],
    ['Refund transfer reference', 'OUT123'],
    ['Refund time (local)', '2020-01-02T12:30'],
    ['Verification notes', 'Full refund verified'],
    ['Authenticator code', '123456'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const submit = screen.getByRole('button', { name: 'Confirm verified refund' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(submit);
}
it('requires case-scoped authenticator verification before refund and excludes the code from refund data', async () => {
  await fillRefund();
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  expect(m.post.mock.calls[0][0]).toBe('/security/step-up/verify');
  expect(m.post.mock.calls[0][1]).toEqual({
    purpose: 'LATE_PAYMENT_REFUND:case',
    factorType: 'TOTP',
    code: '123456',
  });
  expect(m.post.mock.calls[1][0]).toBe('/late-payments/case/refund');
  expect(m.post.mock.calls[1][1]).toMatchObject({
    verifiedAmount: 500,
    verified: true,
    refundReference: 'OUT123',
  });
  expect(m.post.mock.calls[1][1]).not.toHaveProperty('code');
});
it('does not submit a refund after failed authenticator verification', async () => {
  m.post.mockRejectedValue(new Error('Invalid authenticator'));
  await fillRefund();
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid authenticator');
  expect(m.post).toHaveBeenCalledOnce();
});

it.each([
  ['JPY', '525', 525],
  ['KWD', '5.251', 5251],
] as const)('records exact verified %s refund minor units', async (currency, amount, minor) => {
  await fillRefund(currency, amount);
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  expect(m.post.mock.calls[1][1]).toMatchObject({ verifiedAmount: minor });
});
it('renders reported recovery amounts using the order currency precision', async () => {
  m.get.mockResolvedValue({
    data: [{ ...item, paidAmount: 5251, order: { ...item.order, fiatCurrency: 'KWD' } }],
  });
  mount(<LatePaymentCases />);
  expect(await screen.findByText(/Reported transfer: IN123 · 5.251 KWD/)).toBeTruthy();
});

it('only supervisors see release/reject controls and decisions require a reason', async () => {
  m.role = 'SUPER_ADMIN';
  mount(<LatePaymentCases admin />);
  fireEvent.click(await screen.findByRole('button', {name:'Reject claim'}));
  const confirm = screen.getByRole('button', {name:'Confirm rejection'});
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Decision reason'), {target:{value:'No verified incoming transfer'}});
  fireEvent.click(confirm);
  await waitFor(()=>expect(m.post).toHaveBeenCalledWith('/late-payments/case/reject', expect.objectContaining({reason:'No verified incoming transfer',idempotencyKey:expect.any(String)}), undefined, expect.anything()));
});
it('ordinary admins cannot see supervisor decisions', async () => {
  mount(<LatePaymentCases admin />);
  await screen.findByRole('button', {name:'Record verified refund'});
  expect(screen.queryByRole('button',{name:'Release assignment'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Reject claim'})).not.toBeInTheDocument();
});
it('requests the next page and shows a rejected reason', async () => {
  m.get.mockImplementation((path: string) => Promise.resolve({data: path === '/workspaces/access' ? {role:'ADMIN'} : path.includes('?page=1') ? [{...item,status:'REJECTED',resolutionNote:'No transfer found'}] : Array.from({length:50},(_,i)=>({...item,id:`case-${i}`}))}));
  mount(<LatePaymentCases admin />);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Next page'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Next page'}));
  await screen.findByText('Reason: No transfer found');
  expect(m.get).toHaveBeenCalledWith('/late-payments/pending?page=1');
  expect(screen.getByRole('button',{name:'Previous page'})).toBeEnabled();
});
