import { useId, useState, type Dispatch } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  VF_LIMITS,
  clubById,
  parseSelection,
  type LineInput,
  type VfFixtureView,
} from '@socialplay/shared';
import { formatCredits, formatOdds } from '@/lib/football/format';
import {
  currentQuote,
  pickKey,
  type Pick,
  type SlipAction,
  type SlipPreview,
  type SlipState,
} from '@/lib/football/slip';

const QUICK = [5, 10, 25, 50] as const;

function fixtureTitle(fixture: VfFixtureView | undefined) {
  if (!fixture) return 'Match';
  return `${clubById(fixture.homeClub).code} v ${clubById(fixture.awayClub).code}`;
}
function pickLabel(
  pick: { selection: string; fixtureId: string },
  fixture: VfFixtureView | undefined
) {
  const selection = parseSelection(pick.selection);
  if (!selection || !fixture) return pick.selection;
  return selection.label({
    home: clubById(fixture.homeClub).name,
    away: clubById(fixture.awayClub).name,
  });
}

function StakeInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="vf-stake">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={VF_LIMITS.minLineStake}
        max={VF_LIMITS.maxLineStake}
        step={1}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const text = e.target.value;
          onChange(text === '' ? null : Math.trunc(Number(text)));
        }}
        aria-describedby={`${id}-hint`}
      />
      <span id={`${id}-hint`} className="sr-only">
        {VF_LIMITS.minLineStake} to {VF_LIMITS.maxLineStake} practice credits
      </span>
      <div className="vf-quick">
        {QUICK.map((n) => (
          <button
            key={n}
            type="button"
            disabled={disabled}
            aria-pressed={value === n}
            onClick={() => onChange(n)}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Slip({
  slip,
  dispatch,
  fixtures,
  balance,
  closedReason,
  busy,
  locked,
  stale,
  preview,
  ticketsPlaced,
  onReview,
}: {
  slip: SlipState;
  dispatch: Dispatch<SlipAction>;
  fixtures: VfFixtureView[];
  balance: number;
  /** Why selections cannot change right now (closed, offline, rules changed), or null when open. */
  closedReason: string | null;
  busy: boolean;
  /** An unresolved confirmation exists: the slip is frozen until it is resolved. */
  locked: boolean;
  stale: Pick[];
  preview: SlipPreview;
  ticketsPlaced: number;
  onReview: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const frozen = !!closedReason || busy || locked;
  const chosenFixtures = new Set(
    chosen.map((k) => slip.picks.find((p) => pickKey(p) === k)?.fixtureId)
  );
  const canMultiple =
    chosen.length >= VF_LIMITS.minLegsPerMultiple &&
    chosen.length <= VF_LIMITS.maxLegsPerMultiple &&
    chosenFixtures.size === chosen.length &&
    slip.multiples.length + slip.picks.length < 40;
  const lineCount = preview.lines.length;
  const overLines = lineCount > VF_LIMITS.maxLines;
  const exceeded = ticketsPlaced >= VF_LIMITS.maxTicketsPerMatchweek;
  const insufficient = preview.totalStake > balance;
  const blocked =
    frozen ||
    !!preview.error ||
    overLines ||
    exceeded ||
    insufficient ||
    stale.length > 0 ||
    lineCount === 0;
  const reason = closedReason
    ? closedReason
    : locked
      ? 'Resolve your unconfirmed ticket first.'
      : stale.length
        ? 'Prices changed. Review the updated prices.'
        : exceeded
          ? `You have placed ${VF_LIMITS.maxTicketsPerMatchweek} tickets this matchweek.`
          : overLines
            ? `A ticket holds at most ${VF_LIMITS.maxLines} lines.`
            : insufficient
              ? 'Not enough practice credits.'
              : preview.error;

  return (
    <aside className="vf-slip" aria-label="Ticket slip">
      <header className="vf-slip-head">
        <h2>Your ticket</h2>
        <span aria-label={`${slip.picks.length} selections`}>{slip.picks.length}</span>
        {slip.picks.length > 0 && (
          <button
            type="button"
            className="vf-link"
            disabled={frozen}
            onClick={() => (setChosen([]), dispatch({ type: 'clear' }))}
          >
            Clear
          </button>
        )}
      </header>

      {slip.picks.length === 0 ? (
        <p className="vf-slip-empty">
          Tap a price to add it. Stake each selection as a single, or combine two to five matches
          into a multiple. One ticket can hold up to {VF_LIMITS.maxLines} lines.
        </p>
      ) : (
        <>
          {stale.length > 0 && (
            <div role="alert" className="vf-stale">
              <p>
                {stale.length === 1 ? 'A price has' : `${stale.length} prices have`} changed.
                Nothing can be confirmed until you accept the updated prices.
              </p>
              <button
                type="button"
                onClick={() => dispatch({ type: 'acceptPrices', quote: staleQuote(fixtures) })}
              >
                Accept new prices
              </button>
            </div>
          )}
          <ul className="vf-picks" aria-label="Selections">
            {slip.picks.map((pick, index) => {
              const key = pickKey(pick);
              const fixture = byId.get(pick.fixtureId);
              const line = preview.lines.find(
                (l) =>
                  l.line.kind === 'SINGLE' &&
                  l.line.legs[0].fixtureId === pick.fixtureId &&
                  l.line.legs[0].selection === pick.selection
              );
              const isStale = stale.some((p) => pickKey(p) === key);
              return (
                <li key={key} data-stale={isStale}>
                  <div className="vf-pick-head">
                    <label className="vf-pick-choose">
                      <input
                        type="checkbox"
                        checked={chosen.includes(key)}
                        disabled={frozen}
                        onChange={(e) =>
                          setChosen((c) =>
                            e.target.checked ? [...c, key] : c.filter((k) => k !== key)
                          )
                        }
                        aria-label={`Include ${pickLabel(pick, fixture)} in a multiple`}
                      />
                    </label>
                    <div className="vf-pick-text">
                      <span className="vf-pick-match">{fixtureTitle(fixture)}</span>
                      <b>{pickLabel(pick, fixture)}</b>
                    </div>
                    <span className="vf-pick-odds">{formatOdds(pick.quotedCents)}</span>
                    <button
                      type="button"
                      className="vf-x"
                      disabled={frozen}
                      aria-label={`Remove ${pickLabel(pick, fixture)}`}
                      onClick={() => (
                        setChosen((c) => c.filter((k) => k !== key)),
                        dispatch({ type: 'remove', key })
                      )}
                    >
                      ×
                    </button>
                  </div>
                  <StakeInput
                    label={`Single ${index + 1} stake`}
                    value={slip.singles[key] ?? null}
                    disabled={frozen}
                    onChange={(stake) => dispatch({ type: 'single', key, stake })}
                  />
                  {line && (
                    <LineSummary
                      maxReturn={line.maxReturn}
                      error={line.error}
                      stake={slip.singles[key]}
                    />
                  )}
                </li>
              );
            })}
          </ul>

          <div className="vf-multi-build">
            <button
              type="button"
              disabled={frozen || !canMultiple}
              onClick={() => (dispatch({ type: 'addMultiple', keys: chosen }), setChosen([]))}
            >
              Make a multiple of {chosen.length || '2–5'}
            </button>
            <small>
              {chosen.length > 1 && chosenFixtures.size !== chosen.length
                ? 'A multiple takes one selection per match.'
                : 'Tick 2–5 selections from different matches. Every one must win.'}
            </small>
          </div>

          {slip.multiples.map((multiple, i) => {
            const line = preview.lines.find(
              (l) =>
                l.line.kind === 'MULTIPLE' &&
                l.line.legs.length === multiple.picks.length &&
                l.line.legs.every((g) => multiple.picks.includes(`${g.fixtureId}#${g.selection}`))
            );
            return (
              <section key={multiple.id} className="vf-multiple" aria-label={`Multiple ${i + 1}`}>
                <header>
                  <h3>Multiple of {multiple.picks.length}</h3>
                  <button
                    type="button"
                    className="vf-x"
                    disabled={frozen}
                    aria-label={`Remove multiple ${i + 1}`}
                    onClick={() => dispatch({ type: 'removeMultiple', id: multiple.id })}
                  >
                    ×
                  </button>
                </header>
                <ul>
                  {multiple.picks.map((k) => {
                    const pick = slip.picks.find((p) => pickKey(p) === k);
                    return pick ? (
                      <li key={k}>
                        <span>{pickLabel(pick, byId.get(pick.fixtureId))}</span>
                        <b>{formatOdds(pick.quotedCents)}</b>
                      </li>
                    ) : null;
                  })}
                </ul>
                <StakeInput
                  label={`Multiple ${i + 1} stake`}
                  value={multiple.stake}
                  disabled={frozen}
                  onChange={(stake) => dispatch({ type: 'multipleStake', id: multiple.id, stake })}
                />
                {line && (
                  <LineSummary
                    maxReturn={line.maxReturn}
                    error={line.error}
                    stake={multiple.stake}
                    combined={line.combinedOddsCents}
                  />
                )}
              </section>
            );
          })}
        </>
      )}

      <dl className="vf-totals">
        <div>
          <dt>Lines</dt>
          <dd>{lineCount}</dd>
        </div>
        <div>
          <dt>Total stake</dt>
          <dd>{formatCredits(preview.totalStake)} credits</dd>
        </div>
        <div>
          <dt>Return if every line wins</dt>
          <dd>
            {preview.totalMaxReturn === null
              ? '—'
              : `${formatCredits(preview.totalMaxReturn)} credits`}
          </dd>
        </div>
        <div>
          <dt>Practice credits</dt>
          <dd>{formatCredits(balance)}</dd>
        </div>
      </dl>
      {reason && slip.picks.length > 0 && (
        <p className="vf-slip-reason" role="status">
          {reason}
        </p>
      )}
      <button type="button" className="vf-primary" disabled={blocked} onClick={onReview}>
        Review ticket <span>Free practice only</span>
      </button>
    </aside>
  );
}

function LineSummary({
  maxReturn,
  error,
  stake,
  combined,
}: {
  maxReturn: number | null;
  error: string | null;
  stake: number | null | undefined;
  combined?: number | null;
}) {
  if (!stake) return <p className="vf-line-note">Add a stake to include this line.</p>;
  if (error)
    return (
      <p className="vf-line-error" role="status">
        {error}
      </p>
    );
  return (
    <p className="vf-line-note">
      {combined ? `Combined ${formatOdds(combined)}× · ` : ''}
      Returns {formatCredits(maxReturn)} credits if it wins
    </p>
  );
}

/** Replaces the slip's shown prices with the current official ones, never silently. */
function staleQuote(fixtures: VfFixtureView[]) {
  return (fixtureId: string, selection: string) => {
    const fixture = fixtures.find((f) => f.id === fixtureId);
    if (!fixture) return null;
    return currentQuote(fixture, selection);
  };
}

export function ReviewDialog({
  open,
  onOpenChange,
  lines,
  fixtures,
  balance,
  totalStake,
  totalReturn,
  busy,
  closing,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: LineInput[];
  fixtures: VfFixtureView[];
  balance: number;
  totalStake: number;
  totalReturn: number | null;
  busy: boolean;
  /** Selections are about to close: refuse rather than race the kick-off. */
  closing: boolean;
  onConfirm: () => void;
}) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="vf-overlay" />
        <Dialog.Content className="vf-dialog" aria-describedby="vf-review-desc">
          <Dialog.Title>Review your practice ticket</Dialog.Title>
          <Dialog.Description id="vf-review-desc">
            Practice credits only: no Coins, no cash prizes. A confirmed ticket cannot be changed or
            cancelled.
          </Dialog.Description>
          <ol className="vf-review-lines">
            {lines.map((line, i) => {
              const odds = line.legs.reduce((p, g) => p * BigInt(g.oddsCents), 1n);
              const payout = (BigInt(line.stake) * odds) / 100n ** BigInt(line.legs.length);
              return (
                <li key={i}>
                  <div>
                    <b>{line.kind === 'SINGLE' ? 'Single' : `Multiple of ${line.legs.length}`}</b>
                    <span>{formatCredits(line.stake)} credits</span>
                  </div>
                  <ul>
                    {line.legs.map((g) => (
                      <li key={g.fixtureId + g.selection}>
                        <span>
                          {fixtureTitle(byId.get(g.fixtureId))} ·{' '}
                          {pickLabel(g, byId.get(g.fixtureId))}
                        </span>
                        <b>{formatOdds(g.oddsCents)}</b>
                      </li>
                    ))}
                  </ul>
                  <p>
                    Returns {formatCredits(Number(payout))} credits if it wins (stake included).
                  </p>
                </li>
              );
            })}
          </ol>
          <dl className="vf-totals">
            <div>
              <dt>Total stake</dt>
              <dd>{formatCredits(totalStake)} credits</dd>
            </div>
            <div>
              <dt>Return if every line wins</dt>
              <dd>{totalReturn === null ? '—' : `${formatCredits(totalReturn)} credits`}</dd>
            </div>
            <div>
              <dt>Balance after confirming</dt>
              <dd>{formatCredits(balance - totalStake)} credits</dd>
            </div>
          </dl>
          <p className="vf-fine">
            Matches settle on their official results at full time. Losing lines return 0. Selections
            close at kick-off.
          </p>
          {closing && (
            <p role="alert" className="vf-slip-reason">
              Selections are about to close. A new ticket can no longer be confirmed.
            </p>
          )}
          <div className="vf-dialog-actions">
            <button
              type="button"
              className="vf-primary"
              disabled={busy || closing || totalStake > balance}
              onClick={onConfirm}
            >
              Confirm practice ticket
            </button>
            <Dialog.Close className="vf-secondary">Back to slip</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
