import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: m, unwrapData: (r: { data: unknown }) => r.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'main' } }) }));
import { HeldDepositCases, HeldDepositStatus } from './wallet-held-deposits';

const row = {
  orderId: 'order', orderNumber: 'AG-9', orderStatus: 'PAYMENT_SUBMITTED', fiatAmount: 5000, fiatCurrency: 'ETB',
  coinAmount: 5000, createdAt: '2020-01-01T00:00:00Z', caseStatus: 'ASSIGNED', classification: 'UNREVIEWED',
  memberDeclaration: 'PAID', assignedToMe: true, assigned: true, party: false,
};
const queue = (canAdjudicate: boolean) => ({
  canAdjudicate, cases: [row],
  monitoring: { openHeldOrders: 1, reservedCoins: 5000, oldestHeldAt: null, maxOpenHeldPerMember: 1 },
});
const detail = (policy = { unpaidReleaseEnabled: false, coinCreditEnabled: false, externalReturnEnabled: false }) => ({
  order: { id: 'order', orderNumber: 'AG-9', status: 'PAYMENT_SUBMITTED', agentName: 'Fixture agent', fiatAmount: 5000,
    fiatCurrency: 'ETB', coinAmount: 5000, createdAt: '2020-01-01T00:00:00Z', paymentSubmittedAt: null,
    paymentSnapshot: { accountNumber: 'TEST-ONLY-1' } },
  case: { status: 'ASSIGNED', classification: 'UNREVIEWED', memberDeclaration: 'PAID', assignedToMe: true, version: 3 },
  reservation: { status: 'ACTIVE', amount: 5000 }, memberEvidence: [], events: [], adjudication: null, policy,
  confirmationPurpose: 'HELD_DEPOSIT_ADJUDICATION:order',
});
beforeEach(() => {
  m.get.mockReset();
  m.post.mockReset();
  m.post.mockResolvedValue({ success: true, data: {} });
});
afterEach(cleanup);
const mount = (component: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
    <MemoryRouter>{component}</MemoryRouter>
  </QueryClientProvider>
);
const held = { state: 'UNDER_REVIEW' as const, memberDeclaration: null, canDeclareNotPaid: true, canDeclarePaid: true };

it('tells the member the order is held and asks twice before recording that they did not pay', async () => {
  mount(<HeldDepositStatus orderId="order" held={held} member />);
  expect(screen.getByRole('status')).toHaveTextContent('Do not send another payment');
  fireEvent.click(screen.getByRole('button', { name: 'I did not send this payment' }));
  expect(m.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm: I did not pay' }));
  await waitFor(() => expect(m.post).toHaveBeenCalledWith('/held-deposits/order/declaration', { declaration: 'NOT_PAID' }, undefined, expect.anything()));
});

it('shows agents the state only, and never calls a release a refund', () => {
  mount(<HeldDepositStatus orderId="order" held={{ ...held, state: 'RESOLVED_EXTERNAL_RETURN_RECORDED', canDeclareNotPaid: false, canDeclarePaid: false }} member={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('returned outside the platform. No coins were credited.');
  expect(screen.queryByRole('button')).toBeNull();
  expect(document.body.textContent).not.toMatch(/refund/i);
});

it('gives ordinary administrators the queue without case or decision controls', async () => {
  m.get.mockResolvedValue({ data: queue(false) });
  mount(<HeldDepositCases />);
  expect(await screen.findByText(/AG-9/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open case' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Claim case' })).toBeNull();
  expect(m.get).toHaveBeenCalledTimes(1);
});

it('offers unapproved outcomes as disabled and records only an investigation note without them', async () => {
  m.get.mockImplementation((path: string) => Promise.resolve({ data: path === '/held-deposits' ? queue(true) : detail() }));
  mount(<HeldDepositCases />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open case' }));
  expect(await screen.findByText('TEST-ONLY-1')).toBeInTheDocument();
  for (const name of [/Verified payment received/, /Verified external return/, /Verified unpaid/])
    expect(screen.getByRole('option', { name })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: 'Bank confirmation still pending.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save investigation note' }));
  await waitFor(() => expect(m.post).toHaveBeenCalledOnce());
  expect(m.post.mock.calls[0].slice(0, 2)).toEqual(['/held-deposits/order/investigate', { expectedCaseVersion: 3, note: 'Bank confirmation still pending.' }]);
});

it('requires evidence, a personal check and a case-specific code before a credit, and retries with the same key', async () => {
  m.get.mockImplementation((path: string) => Promise.resolve({ data: path === '/held-deposits' ? queue(true)
    : detail({ unpaidReleaseEnabled: false, coinCreditEnabled: true, externalReturnEnabled: false }) }));
  mount(<HeldDepositCases />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open case' }));
  fireEvent.change(await screen.findByLabelText('Decision'), { target: { value: 'VERIFIED_PAYMENT_RECEIVED' } });
  const submit = screen.getByRole('button', { name: 'Record decision' });
  const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fill('Decision reason', 'Statement shows the transfer arrived.');
  fill('Evidence reference', 'STATEMENT-1');
  fill('What the evidence shows', 'Incoming transfer for the exact amount.');
  fill('Verified incoming reference', 'pay-123');
  fill('Verified amount (ETB)', '50.00');
  fill('Transfer time (local)', '2020-01-02T12:30');
  fill('Authenticator code', '123456');
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  expect(submit).toBeEnabled();
  let adjudications = 0;
  m.post.mockImplementation((path: string) => path.endsWith('/adjudicate') && ++adjudications === 1
    ? Promise.reject(new Error('timeout')) : Promise.resolve({ success: true, data: {} }));
  fireEvent.click(submit);
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  expect(m.post.mock.calls[0].slice(0, 2)).toEqual(['/security/step-up/verify', { purpose: 'HELD_DEPOSIT_ADJUDICATION:order', factorType: 'TOTP', code: '123456' }]);
  const first = m.post.mock.calls[1][1];
  expect(first).toMatchObject({ outcome: 'VERIFIED_PAYMENT_RECEIVED', expectedCaseVersion: 3, verifiedPaymentReference: 'pay-123', verifiedAmount: 5000, verified: true,
    evidence: [{ kind: 'BANK_STATEMENT', reference: 'STATEMENT-1', description: 'Incoming transfer for the exact amount.' }] });
  expect(first).not.toHaveProperty('returnReference');
  // Uncertain failure: a second attempt repeats the same idempotency key.
  fill('Authenticator code', '654321');
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(4));
  expect(m.post.mock.calls[3][1].idempotencyKey).toBe(first.idempotencyKey);
});


it('requires a reason for takeover, sends the displayed version and blocks duplicate clicks while pending', async () => {
  const other = detail(); other.case.assignedToMe = false;
  m.get.mockImplementation((path: string) => Promise.resolve({ data: path === '/held-deposits' ? queue(true) : other }));
  let reject!: (e: unknown) => void;
  m.post.mockImplementation(() => new Promise((_resolve, no) => { reject = no; }));
  mount(<HeldDepositCases />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open case' }));
  const button = await screen.findByRole('button', { name: 'Take over case' });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: 'Assigned administrator unavailable for the review.' } });
  fireEvent.click(button); fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(m.post).toHaveBeenCalledOnce();
  expect(m.post.mock.calls[0].slice(0, 2)).toEqual(['/held-deposits/order/reassign', { expectedCaseVersion: 3, note: 'Assigned administrator unavailable for the review.' }]);
  reject(new Error('Case changed; reload it and review again'));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Record decision' })).toBeNull();
});
