import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
const m = vi.hoisted(() => ({ user: { id: 'u', username: 'member' }, get: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: m.user, logout: vi.fn() }),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<any>()), api: { get: m.get } }));
import { WorkspaceGate, AdminOverview, AdminAccounts } from './index';
function show(child: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>{child}</MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
});
it('does not mount administrator tools for a member', async () => {
  m.get.mockResolvedValue({
    success: true,
    data: { admin: false, agent: false, role: 'USER', agentStatus: null },
  });
  show(
    <WorkspaceGate kind="admin">
      <p>Private admin tools</p>
    </WorkspaceGate>
  );
  expect(await screen.findByText('Administrator access required')).toBeInTheDocument();
  expect(screen.queryByText('Private admin tools')).not.toBeInTheDocument();
});
it('admin does not automatically receive agent access', async () => {
  m.get.mockResolvedValue({
    success: true,
    data: { admin: true, agent: false, role: 'ADMIN', agentStatus: null },
  });
  show(
    <WorkspaceGate kind="agent">
      <p>Agent tools</p>
    </WorkspaceGate>
  );
  expect(await screen.findByText('Approved agent access required')).toBeInTheDocument();
  expect(screen.queryByText('Agent tools')).not.toBeInTheDocument();
});
it('fails closed when access verification fails', async () => {
  m.get.mockRejectedValue(new Error('offline'));
  show(
    <WorkspaceGate kind="admin">
      <p>Private admin tools</p>
    </WorkspaceGate>
  );
  expect(await screen.findByText('Access could not be verified')).toBeInTheDocument();
  expect(screen.queryByText('Private admin tools')).not.toBeInTheDocument();
});
it.each(['admin', 'agent'] as const)('admits server-approved %s workspace', async (kind) => {
  m.get.mockResolvedValue({
    success: true,
    data: { admin: kind === 'admin', agent: kind === 'agent' },
  });
  show(
    <WorkspaceGate kind={kind}>
      <p>Allowed workspace</p>
    </WorkspaceGate>
  );
  expect(await screen.findByText('Allowed workspace')).toBeInTheDocument();
});
it('shows actual dashboard totals and no fabricated activity', async () => {
  m.get.mockResolvedValue({
    success: true,
    data: {
      members: 42,
      agents: 0,
      groups: 2,
      games: 7,
      applications: 0,
      accounts: 0,
      countries: 0,
      asOf: '2026-10-05T00:00:00Z',
    },
  });
  show(<AdminOverview />);
  expect(await screen.findByText('42')).toBeInTheDocument();
  expect(screen.getByText('Member accounts')).toBeInTheDocument();
});
it('empty account directory has an explicit state and no next page', async () => {
  m.get.mockResolvedValue({ success: true, data: { rows: [], total: 0, pageSize: 50 } });
  show(<AdminAccounts />);
  expect(await screen.findByText('No matching accounts.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});
