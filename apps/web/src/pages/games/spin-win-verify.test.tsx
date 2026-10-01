import { webcrypto } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { PUBLICATION_ARCHIVE } from '@/test/spin-publication-fixture';
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
    expect(
      await screen.findByRole('heading', { name: 'Verify a Spin Win round' })
    ).toBeInTheDocument();
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
  it('explains how to enable browser cryptography without treating its absence as a bad proof', async () => {
    const actual = await vi.importActual<typeof Verifier>('@/lib/spin-proof-verifier');
    mocked.verify.mockImplementation(actual.verifyPublicSpinProof);
    vi.stubGlobal('crypto', {});
    mount();
    enter();
    fireEvent.click(screen.getByRole('button', { name: 'Verify locally' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/HTTPS or localhost/);
    expect(alert).toHaveTextContent(/browser that supports Web Crypto/);
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

describe('portable publication evidence downloads', () => {
  const loadArchive = async (data: unknown = PUBLICATION_ARCHIVE) => {
    const text = new TextEncoder().encode(JSON.stringify({ success: true, data }));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(text);
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), body }));
    const actual = await vi.importActual<typeof Verifier>('@/lib/spin-proof-verifier');
    mocked.verify.mockImplementation(actual.verifyPublicSpinProof);
    vi.stubGlobal('crypto', webcrypto);
    mount();
    fireEvent.change(screen.getByLabelText('Round ID'), {
      target: { value: PUBLICATION_ARCHIVE.roundId },
    });
  };
  it('offers evidence, never claims timestamp verification, and clears it after edits', async () => {
    await loadArchive();
    fireEvent.click(screen.getByRole('button', { name: 'Load timestamp archive' }));
    await screen.findByText('Archive ready to save');
    expect(
      screen.getByText('Response bytes included · timestamp signature not verified here')
    ).toBeInTheDocument();
    expect(screen.getByText(/browser checked structure and hashes only/)).toBeInTheDocument();
    expect(screen.queryByText(/Verified result/)).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('Earlier saved commitment (optional)'), {
      target: { value: '{}' },
    });
    expect(
      screen.queryByRole('button', { name: 'Download timestamp archive' })
    ).not.toBeInTheDocument();
  });
  it('matches an earlier saved commitment and downloads the original archive bytes', async () => {
    await loadArchive();
    const create = vi.fn().mockReturnValue('blob:test-archive'),
      revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      }
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    fireEvent.change(screen.getByLabelText('Earlier saved commitment (optional)'), {
      target: { value: JSON.stringify(PUBLICATION_ARCHIVE.proof) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load timestamp archive' }));
    await screen.findByText('Matches your saved commitment.');
    fireEvent.click(screen.getByRole('button', { name: 'Download timestamp archive' }));
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0]).toHaveProperty(
      'download',
      'spin-publication-spin-proof-v2_17.json'
    );
    expect(revoke).toHaveBeenCalledWith('blob:test-archive');
    click.mockRestore();
  });
  it('request-only evidence has no timestamp-receipt claim', async () => {
    await loadArchive({ ...PUBLICATION_ARCHIVE, receipt: null });
    fireEvent.click(screen.getByRole('button', { name: 'Load timestamp archive' }));
    await screen.findByText('Request only · no timestamp receipt included');
    expect(screen.queryByText(/Verified result/)).not.toBeInTheDocument();
  });
  it('saved-receipt mismatch prevents the download and hides input errors', async () => {
    await loadArchive();
    fireEvent.change(screen.getByLabelText('Earlier saved commitment (optional)'), {
      target: { value: '{"private":"bad receipt"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load timestamp archive' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not check the timestamp archive'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/bad receipt/);
    expect(
      screen.queryByRole('button', { name: 'Download timestamp archive' })
    ).not.toBeInTheDocument();
  });
  it('shows secure-browser guidance rather than a false successful archive', async () => {
    await loadArchive();
    vi.stubGlobal('crypto', {});
    fireEvent.click(screen.getByRole('button', { name: 'Load timestamp archive' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTPS or localhost');
    expect(
      screen.queryByRole('button', { name: 'Download timestamp archive' })
    ).not.toBeInTheDocument();
  });
});
