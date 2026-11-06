import { footballSelectionLabel, type InterfaceTranslate } from '@/lib/i18n/game-labels';
import { clubById } from '@/lib/football/clubs';
import { useId, useState, type Dispatch } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { VF_LIMITS, parseSelection, type LineInput, type VfFixtureView } from '@socialplay/shared';
import { formatCredits, formatOdds } from '@/lib/football/format';
import {
  currentQuote,
  pickKey,
  type Pick,
  type SlipAction,
  type SlipPreview,
  type SlipState,
} from '@/lib/football/slip';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

const QUICK = [5, 10, 25, 50] as const;

function fixtureTitle(fixture: VfFixtureView | undefined) {
  if (!fixture) return 'Match';
  return `${clubById(fixture.homeClub).code} v ${clubById(fixture.awayClub).code}`;
}
function pickLabel(
  pick: { selection: string; fixtureId: string },
  fixture: VfFixtureView | undefined,
  t: InterfaceTranslate
) {
  const selection = parseSelection(pick.selection);
  if (!selection || !fixture) return pick.selection;
  return footballSelectionLabel(
    selection,
    {
      home: clubById(fixture.homeClub).name,
      away: clubById(fixture.awayClub).name,
    },
    t
  );
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
  const { t: translateUi } = useInterfaceLanguage();

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
        {translateUi('{minLineStake} to {maxLineStake} practice ETB', {
          minLineStake: VF_LIMITS.minLineStake,
          maxLineStake: VF_LIMITS.maxLineStake,
        })}
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
  const { t: translateUi } = useInterfaceLanguage();

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
          ? translateUi('You have placed {count} tickets this matchweek.', {
              count: VF_LIMITS.maxTicketsPerMatchweek,
            })
          : overLines
            ? translateUi('A ticket holds at most {count} lines.', { count: VF_LIMITS.maxLines })
            : insufficient
              ? 'Not enough practice ETB.'
              : preview.error;

  return (
    <aside className="vf-slip" aria-label={translateUi('Ticket slip')}>
      <header className="vf-slip-head">
        <h2>{translateUi('Your ticket')}</h2>
        <span aria-label={translateUi('{length} selections', { length: slip.picks.length })}>
          {slip.picks.length}
        </span>
        {slip.picks.length > 0 && (
          <button
            type="button"
            className="vf-link"
            disabled={frozen}
            onClick={() => (setChosen([]), dispatch({ type: 'clear' }))}
          >
            {translateUi('Clear')}
          </button>
        )}
      </header>

      {slip.picks.length === 0 ? (
        <p className="vf-slip-empty">
          {translateUi(
            'Tap a price to add it. Stake each selection as a single, or combine two to five matches into a multiple. One ticket can hold up to {maxLines} lines.',
            { maxLines: VF_LIMITS.maxLines }
          )}
        </p>
      ) : (
        <>
          {stale.length > 0 && (
            <div role="alert" className="vf-stale">
              <p>
                {translateUi(
                  'Prices changed for {count} selections. Accept the updated prices before confirming.',
                  { count: stale.length }
                )}
              </p>
              <button
                type="button"
                onClick={() => dispatch({ type: 'acceptPrices', quote: staleQuote(fixtures) })}
              >
                {translateUi('Accept new prices')}
              </button>
            </div>
          )}
          <ul className="vf-picks" aria-label={translateUi('Selections')}>
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
                        aria-label={translateUi('Include {value} in a multiple', {
                          value: pickLabel(pick, fixture, translateUi),
                        })}
                      />
                    </label>
                    <div className="vf-pick-text">
                      <span className="vf-pick-match">{fixtureTitle(fixture)}</span>
                      <b>{pickLabel(pick, fixture, translateUi)}</b>
                    </div>
                    <span className="vf-pick-odds">{formatOdds(pick.quotedCents)}</span>
                    <button
                      type="button"
                      className="vf-x"
                      disabled={frozen}
                      aria-label={translateUi('Remove {value}', {
                        value: pickLabel(pick, fixture, translateUi),
                      })}
                      onClick={() => (
                        setChosen((c) => c.filter((k) => k !== key)),
                        dispatch({ type: 'remove', key })
                      )}
                    >
                      ×
                    </button>
                  </div>
                  <StakeInput
                    label={translateUi('Single {value} stake', { value: index + 1 })}
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
              {translateUi('Make a multiple of {value}', { value: chosen.length || '2–5' })}
            </button>
            <small>
              {chosen.length > 1 && chosenFixtures.size !== chosen.length
                ? translateUi('A multiple takes one selection per match.')
                : translateUi('Tick 2–5 selections from different matches. Every one must win.')}
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
              <section
                key={multiple.id}
                className="vf-multiple"
                aria-label={translateUi('Multiple {value}', { value: i + 1 })}
              >
                <header>
                  <h3>{translateUi('Multiple of {length}', { length: multiple.picks.length })}</h3>
                  <button
                    type="button"
                    className="vf-x"
                    disabled={frozen}
                    aria-label={translateUi('Remove multiple {value}', { value: i + 1 })}
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
                        <span>{pickLabel(pick, byId.get(pick.fixtureId), translateUi)}</span>
                        <b>{formatOdds(pick.quotedCents)}</b>
                      </li>
                    ) : null;
                  })}
                </ul>
                <StakeInput
                  label={translateUi('Multiple {value} stake', { value: i + 1 })}
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
          <dt>{translateUi('Lines')}</dt>
          <dd>{lineCount}</dd>
        </div>
        <div>
          <dt>{translateUi('Total stake')}</dt>
          <dd>{translateUi('{value} ETB', { value: formatCredits(preview.totalStake) })}</dd>
        </div>
        <div>
          <dt>{translateUi('Return if every line wins')}</dt>
          <dd>
            {preview.totalMaxReturn === null
              ? '—'
              : translateUi('{value} ETB', { value: formatCredits(preview.totalMaxReturn) })}
          </dd>
        </div>
        <div>
          <dt>{translateUi('Practice ETB')}</dt>
          <dd>{formatCredits(balance)}</dd>
        </div>
      </dl>
      {reason && slip.picks.length > 0 && (
        <p className="vf-slip-reason" role="status">
          {reason}
        </p>
      )}
      <button type="button" className="vf-primary" disabled={blocked} onClick={onReview}>
        {translateUi('Review ticket') + ' '}
        <span>{translateUi('Free practice only')}</span>
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
  const { t: translateUi } = useInterfaceLanguage();

  if (!stake)
    return <p className="vf-line-note">{translateUi('Add a stake to include this line.')}</p>;
  if (error)
    return (
      <p className="vf-line-error" role="status">
        {translateUi(error)}
      </p>
    );
  return (
    <p className="vf-line-note">
      {translateUi('{value}Returns {value2} ETB if it wins', {
        value: combined
          ? translateUi('Combined {value}× ·', { value: formatOdds(combined) }) + ' '
          : '',
        value2: formatCredits(maxReturn),
      })}
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
  const { t: translateUi } = useInterfaceLanguage();

  const byId = new Map(fixtures.map((f) => [f.id, f]));
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="vf-overlay" />
        <Dialog.Content className="vf-dialog" aria-describedby="vf-review-desc">
          <Dialog.Title>{translateUi('Review your practice ticket')}</Dialog.Title>
          <Dialog.Description id="vf-review-desc">
            {translateUi(
              'Practice ETB only: no cash stakes or prizes. A confirmed ticket cannot be changed or cancelled.'
            )}
          </Dialog.Description>
          <ol className="vf-review-lines">
            {lines.map((line, i) => {
              const odds = line.legs.reduce((p, g) => p * BigInt(g.oddsCents), 1n);
              const payout = (BigInt(line.stake) * odds) / 100n ** BigInt(line.legs.length);
              return (
                <li key={i}>
                  <div>
                    <b>
                      {line.kind === 'SINGLE'
                        ? translateUi('Single')
                        : translateUi('Multiple of {length}', { length: line.legs.length })}
                    </b>
                    <span>{translateUi('{value} ETB', { value: formatCredits(line.stake) })}</span>
                  </div>
                  <ul>
                    {line.legs.map((g) => (
                      <li key={g.fixtureId + g.selection}>
                        <span>
                          {fixtureTitle(byId.get(g.fixtureId))} ·{' '}
                          {pickLabel(g, byId.get(g.fixtureId), translateUi)}
                        </span>
                        <b>{formatOdds(g.oddsCents)}</b>
                      </li>
                    ))}
                  </ul>
                  <p>
                    {translateUi('Returns {value} ETB if it wins (stake included).', {
                      value: formatCredits(Number(payout)),
                    })}
                  </p>
                </li>
              );
            })}
          </ol>
          <dl className="vf-totals">
            <div>
              <dt>{translateUi('Total stake')}</dt>
              <dd>{translateUi('{value} ETB', { value: formatCredits(totalStake) })}</dd>
            </div>
            <div>
              <dt>{translateUi('Return if every line wins')}</dt>
              <dd>
                {totalReturn === null
                  ? '—'
                  : translateUi('{value} ETB', { value: formatCredits(totalReturn) })}
              </dd>
            </div>
            <div>
              <dt>{translateUi('Balance after confirming')}</dt>
              <dd>{translateUi('{value} ETB', { value: formatCredits(balance - totalStake) })}</dd>
            </div>
          </dl>
          <p className="vf-fine">
            {translateUi(
              'Matches settle on their official results at full time. Losing lines return 0. Selections close at kick-off.'
            )}
          </p>
          {closing && (
            <p role="alert" className="vf-slip-reason">
              {translateUi(
                'Selections are about to close. A new ticket can no longer be confirmed.'
              )}
            </p>
          )}
          <div className="vf-dialog-actions">
            <button
              type="button"
              className="vf-primary"
              disabled={busy || closing || totalStake > balance}
              onClick={onConfirm}
            >
              {translateUi('Confirm practice ticket')}
            </button>
            <Dialog.Close className="vf-secondary">{translateUi('Back to slip')}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
