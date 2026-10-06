import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: m,
  unwrapData: (r: any) => {
    if (!r.success) throw Error('failed');
    return r.data;
  },
}));
import { AuthenticatorSetup } from './authenticator-setup';
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  m.get.mockResolvedValue({ success: true, data: { factors: [] } });
});
const mount = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AuthenticatorSetup />
    </QueryClientProvider>
  );
it('enrolls then clears the setup key and code after activation', async () => {
  m.post.mockImplementation(async (path) => {
    if (path.endsWith('/start'))
      return {
        success: true,
        data: {
          secret: 'DISPOSABLEFIXTURE',
          challenge: 'test-challenge',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      };
    m.get.mockResolvedValue({
      success: true,
      data: { factors: [{ type: 'TOTP', status: 'ACTIVE' }] },
    });
    return { success: true, data: { status: 'ACTIVE' } };
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
  expect(await screen.findByLabelText('Setup key')).toHaveValue('DISPOSABLEFIXTURE');
  fireEvent.change(screen.getByLabelText('Six-digit authenticator code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm authenticator' }));
  await waitFor(() => expect(screen.queryByLabelText('Setup key')).not.toBeInTheDocument());
  expect(m.post.mock.calls[1][1]).toEqual({ challenge: 'test-challenge', code: '123456' });
  expect(await screen.findByText('Authenticator enabled')).toBeInTheDocument();
});
it('does not retry an uncertain start or store its secret in the query cache', async () => {
  m.post.mockRejectedValue(new Error('Connection lost'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Set up authenticator' })).toBeEnabled()
  );
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Setup key')).not.toBeInTheDocument();
});
it('clears a rejected verification code and reconciles an activation whose response was lost', async () => {
  m.post.mockResolvedValueOnce({
    success: true,
    data: {
      secret: 'FIXTURE',
      challenge: 'test',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
  await screen.findByLabelText('Setup key');
  await waitFor(() => expect(screen.getByLabelText('Six-digit authenticator code')).toBeEnabled());
  m.post.mockImplementationOnce(async () => {
    m.get.mockResolvedValue({
      success: true,
      data: { factors: [{ type: 'TOTP', status: 'ACTIVE' }] },
    });
    throw Error('Response lost');
  });
  fireEvent.change(screen.getByLabelText('Six-digit authenticator code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm authenticator' }));
  await screen.findByText('Authenticator enabled');
  expect(screen.queryByLabelText('Setup key')).not.toBeInTheDocument();
  expect(m.post).toHaveBeenCalledTimes(2);
});
