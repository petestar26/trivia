import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE } from '@/lib/api-config';
import {
  MAX_PUBLIC_PROOF_BYTES,
  parsePublicProofText,
  verifyPublicSpinProof,
} from '@/lib/spin-proof-verifier';
import type { PublicSpinVerification } from '@/lib/spin-proof-verifier';

export function SpinWinVerifyPage() {
  const [roundId, setRoundId] = useState('');
  const [proofText, setProofText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PublicSpinVerification | null>(null);
  const alive = useRef(true);
  const work = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      work.current?.abort();
    };
  }, []);
  const reset = () => {
    setResult(null);
    setError('');
  };
  const load = async () => {
    if (!/^[A-Za-z0-9_:-]{1,128}$/.test(roundId)) {
      setError('Enter a valid round ID');
      return;
    }
    reset();
    setProofText('');
    setBusy(true);
    const controller = new AbortController();
    work.current = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(
        `${API_BASE}/games/scheduled/spin-win/proofs/${encodeURIComponent(roundId)}`,
        {
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
        }
      );
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? 'No future-beacon proof is published for this round'
            : 'Round proof is temporarily unavailable'
        );
      const body = (await response.json()) as { success: boolean; data: unknown };
      if (!body.success) throw new Error('Round proof is unavailable');
      const text = JSON.stringify(body.data, null, 2);
      parsePublicProofText(text);
      if (alive.current) setProofText(text);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error && cause.name !== 'AbortError'
            ? cause.message
            : 'Could not load the proof. Please retry.'
        );
    } finally {
      clearTimeout(timeout);
      if (alive.current) setBusy(false);
    }
  };
  const verify = async () => {
    reset();
    setBusy(true);
    try {
      const verified = await verifyPublicSpinProof(
        parsePublicProofText(proofText),
        savedText.trim() ? parsePublicProofText(savedText) : undefined
      );
      if (alive.current) setResult(verified);
    } catch {
      if (alive.current)
        setError('Verification failed. Check the proof, saved receipt, protocol and result.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const upload = async (file: File | undefined, saved: boolean) => {
    if (!file) return;
    reset();
    setBusy(true);
    try {
      if (file.size > MAX_PUBLIC_PROOF_BYTES) throw new Error('File exceeds 32 KiB');
      const text = await file.text();
      parsePublicProofText(text);
      if (alive.current) (saved ? setSavedText : setProofText)(text);
    } catch {
      if (alive.current) setError('Choose a JSON file of at most 32 KiB');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result.proof, null, 2)], { type: 'application/json' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `spin-proof-${result.proof.commitment.roundId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-6">
        <Link to="/games/spin-win" className="text-sm text-amber-200">
          ← Spin Win
        </Link>
        <header>
          <p className="text-xs uppercase tracking-widest text-amber-300">
            PlayQube · Round transparency
          </p>
          <h1 className="mt-2 text-3xl font-bold">Verify a Spin Win round</h1>
          <p className="mt-3 text-slate-300">
            Check a published commitment and reproduce the result locally in your browser.
            Verification only · No bets or deposits.
          </p>
        </header>
        <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
          <label htmlFor="proof-round" className="block text-sm font-medium">
            Round ID
          </label>
          <div className="mt-2 flex flex-wrap gap-3">
            <input
              id="proof-round"
              value={roundId}
              disabled={busy}
              maxLength={128}
              onChange={(e) => {
                setRoundId(e.target.value);
                reset();
              }}
              className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-950 p-3"
              placeholder="stream:sequence"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void load()}
              className="rounded-lg bg-amber-300 px-5 py-3 font-semibold text-slate-950 disabled:opacity-50"
            >
              Load published proof
            </button>
          </div>
          <p className="mt-3 text-sm text-slate-400">
            Only future-beacon financial rounds have this proof. Solo and scheduled practice rounds
            use different protocols.
          </p>
        </section>
        <section className="space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-5">
          <label htmlFor="proof-json" className="block text-sm font-medium">
            Round proof JSON
          </label>
          <textarea
            id="proof-json"
            value={proofText}
            disabled={busy}
            maxLength={MAX_PUBLIC_PROOF_BYTES}
            rows={9}
            onChange={(e) => {
              setProofText(e.target.value);
              reset();
            }}
            className="w-full rounded-lg border border-slate-600 bg-slate-950 p-3 font-mono text-xs"
          />
          <label className="block text-sm">
            Upload proof JSON{' '}
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => void upload(e.target.files?.[0], false)}
              className="mt-2 block text-sm"
            />
          </label>
          <label htmlFor="saved-json" className="block text-sm font-medium">
            Earlier saved commitment (optional)
          </label>
          <textarea
            id="saved-json"
            value={savedText}
            disabled={busy}
            maxLength={MAX_PUBLIC_PROOF_BYTES}
            rows={4}
            onChange={(e) => {
              setSavedText(e.target.value);
              reset();
            }}
            className="w-full rounded-lg border border-slate-600 bg-slate-950 p-3 font-mono text-xs"
          />
          <label className="block text-sm">
            Upload saved receipt{' '}
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => void upload(e.target.files?.[0], true)}
              className="mt-2 block text-sm"
            />
          </label>
          <button
            type="button"
            disabled={busy || !proofText.trim()}
            onClick={() => void verify()}
            className="rounded-lg bg-emerald-400 px-5 py-3 font-semibold text-slate-950 disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Verify locally'}
          </button>
        </section>
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-rose-400/30 bg-rose-950 p-4 text-rose-100"
          >
            {error}
          </p>
        )}
        {result && (
          <section
            role="status"
            className="space-y-3 rounded-2xl border border-emerald-400/30 bg-emerald-950/40 p-5"
          >
            <h2 className="text-xl font-bold">
              {result.status === 'VERIFIED'
                ? `Verified result · ${result.computedOutcome}`
                : 'Commitment checked · awaiting draw'}
            </h2>
            <p className="break-all text-sm">Round {result.proof.commitment.roundId}</p>
            <p className="text-sm">
              {result.matchedSavedReceipt
                ? 'Matches your saved commitment.'
                : 'No earlier saved receipt was compared.'}
            </p>
            <p className="text-sm text-slate-300">
              {result.status === 'VERIFIED'
                ? 'Seed commitment, beacon signature and draw agree.'
                : 'The terms and receipt hash agree. The seed and beacon are not yet revealed.'}{' '}
              This does not independently establish publication time, funding or payment.
            </p>
            <details className="text-sm">
              <summary className="cursor-pointer">Commitment details</summary>
              <dl className="mt-3 space-y-2">
                <dt>Receipt hash</dt>
                <dd className="break-all font-mono text-xs">{result.proof.commitmentHash}</dd>
                <dt>Betting cutoff</dt>
                <dd>{new Date(result.proof.commitment.closesAtMs).toISOString()}</dd>
                <dt>Pinned beacon</dt>
                <dd>
                  {result.proof.commitment.beaconRound} ·{' '}
                  {new Date(result.proof.commitment.beaconTimeMs).toISOString()}
                </dd>
              </dl>
            </details>
            <button
              type="button"
              onClick={download}
              className="rounded-lg border border-emerald-300 px-4 py-2"
            >
              Download{' '}
              {result.status === 'COMMITMENT_ONLY' ? 'commitment receipt' : 'verified proof'} JSON
            </button>
          </section>
        )}
        <p className="text-sm text-slate-400">
          Save a commitment receipt before joining a future financial round, then compare it after
          the draw. Retain an independent dated copy if you need evidence of when you observed it.
          The receipt hash identifies its terms; it is not an operator signature or trusted
          timestamp.
        </p>
      </div>
    </main>
  );
}
