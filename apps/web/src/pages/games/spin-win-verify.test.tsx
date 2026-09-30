import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpinWinVerifyPage } from './spin-win-verify';
import { PUBLIC_PROOF } from '@/test/spin-public-proof-fixture';
import type * as Verifier from '@/lib/spin-proof-verifier';
import { App } from '@/App';
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ isLoading: true, isAuthenticated: false, user: null }),
}));
const mocked = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('@/lib/spin-proof-verifier', async (original) => ({
  ...(await original<typeof Verifier>()),
  verifyPublicSpinProof: mocked.verify,
}));
beforeEach(() => {
  mocked.verify.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const mount = () =>
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SpinWinVerifyPage />
    </MemoryRouter>
  );
const enter = () =>
  fireEvent.change(screen.getByLabelText('Round proof JSON'), {
    target: { value: JSON.stringify(PUBLIC_PROOF) },
  });
describe('public player verifier', () => {
  it('the application renders public verification even while its session probe has not resolved', async () => {
    render(
      <MemoryRouter
        initialEntries={['/games/spin-win/verify']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { name: 'Verify a Spin Win round' })).toBeInTheDocument();
    expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument();
  });
  it('needs no login and offers verification without wager controls', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Verify a Spin Win round' })).toBeInTheDocument();
    expect(screen.getByText(/No bets or deposits/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify locally' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /place|join|spin$/i })).not.toBeInTheDocument();
  });
  it('shows verified outcome and honest receipt limitations, then clears stale results on edits', async () => {
    mocked.verify.mockResolvedValue({
      status: 'VERIFIED',
      proof: PUBLIC_PROOF,
      computedOutcome: 19,
      matchedSavedReceipt: false,
    });
    mount();
    enter();
    fireEvent.click(screen.getByRole('button', { name: 'Verify locally' }));
    await screen.findByText('Verified result · 19');
    expect(screen.getByText('No earlier saved receipt was compared.')).toBeInTheDocument();
    expect(
      screen.getByText(/does not independently establish publication time/)
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Earlier saved commitment (optional)'), {
      target: { value: '{}' },
    });
    expect(screen.queryByText('Verified result · 19')).not.toBeInTheDocument();
  });
  it('does not label a pending receipt as a verified draw', async () => {
    mocked.verify.mockResolvedValue({
      status: 'COMMITMENT_ONLY',
      proof: { ...PUBLIC_PROOF, stage: 'PENDING', reveal: null },
      computedOutcome: null,
      matchedSavedReceipt: false,
    });
    mount();
    enter();
    fireEvent.click(screen.getByRole('button', { name: 'Verify locally' }));
    await screen.findByText('Commitment checked · awaiting draw');
    expect(screen.queryByText(/Verified result/)).not.toBeInTheDocument();
  });
  it('fails closed with safe copy on invalid proof', async () => {
    mocked.verify.mockRejectedValue(new Error('untrusted proof contents'));
    mount();
    enter();
    fireEvent.click(screen.getByRole('button', { name: 'Verify locally' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(/untrusted proof contents/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Verified result/)).not.toBeInTheDocument();
  });
  it('loads only the public GET endpoint without credentials', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ success: true, data: PUBLIC_PROOF }) });
    vi.stubGlobal('fetch', fetch);
    mount();
    fireEvent.change(screen.getByLabelText('Round ID'), {
      target: { value: PUBLIC_PROOF.commitment.roundId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load published proof' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Round proof JSON')).toHaveValue(
        JSON.stringify(PUBLIC_PROOF, null, 2)
      )
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/games/scheduled/spin-win/proofs/spin-proof-v2%3A17'),
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' })
    );
    expect(mocked.verify).not.toHaveBeenCalled();
  });
});
