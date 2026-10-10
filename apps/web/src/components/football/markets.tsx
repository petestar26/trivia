import { clubById } from '@/lib/football/clubs';
import { useMemo, useState } from 'react';
import {
  VF_LIMITS,
  VF_MARKETS,
  fixtureOffer,
  selectionsOf,
  type MarketKey,
  type VfFixtureView,
} from '@socialplay/shared';
import { formatOdds } from '@/lib/football/format';

const GROUPS = ['Main', 'Goals', 'Team', 'Combined', 'Handicap', 'Exact'] as const;
type Group = (typeof GROUPS)[number];

/**
 * All typed selections for one fixture, grouped. Every price comes from the same shared
 * function the server uses. A selection priced outside the offered window is shown as
 * unavailable rather than re-priced.
 */
export function MarketPanel({
  fixture,
  picked,
  disabled,
  onToggle,
}: {
  fixture: VfFixtureView;
  picked: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (selection: string, oddsCents: number) => void;
}) {
  const [group, setGroup] = useState<Group>('Main');
  const offer = useMemo(() => fixtureOffer(fixture.params), [fixture.params]);
  const names = useMemo(
    () => ({ home: clubById(fixture.homeClub).name, away: clubById(fixture.awayClub).name }),
    [fixture.homeClub, fixture.awayClub]
  );
  const markets = VF_MARKETS.filter((m) => m.group === group);
  return (
    <div className="vf-markets">
      <div className="vf-group-bar" role="group" aria-label="Market groups">
        {GROUPS.map((g) => (
          <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
      </div>
      {markets.map((market) => {
        const selections = selectionsOf(market.key as MarketKey);
        return (
          <section key={market.key} className="vf-market" aria-label={market.title}>
            <header>
              <h4>{market.title}</h4>
              <details>
                <summary aria-label={`Rules for ${market.title}`}>Rules</summary>
                <p>{market.rule}</p>
              </details>
            </header>
            <div
              className={`vf-selections vf-selections--${market.key.toLowerCase()}`}
              role="group"
              aria-label={`${market.title} selections`}
            >
              {selections.map((s) => {
                const cents = offer.byId.get(s.id)?.oddsCents ?? null;
                const on = picked.has(s.id);
                const available = cents !== null;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="vf-sel"
                    aria-pressed={on}
                    disabled={!available || (disabled && !on)}
                    title={
                      available
                        ? s.label(names)
                        : `Not offered: price outside ${formatOdds(VF_LIMITS.minOddsCents)}–${formatOdds(VF_LIMITS.maxOddsCents)}`
                    }
                    aria-label={`${s.label(names)}, ${available ? `price ${formatOdds(cents)}` : 'not offered'}`}
                    onClick={() => cents !== null && onToggle(s.id, cents)}
                  >
                    <span>{s.short}</span>
                    <b>{available ? formatOdds(cents) : '—'}</b>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      <p className="vf-fine">
        Fixed prices include your stake and are set when the matchweek opens; they never change
        during it. Prices target a 90% average return on each market, rounded down to the hundredth.
      </p>
    </div>
  );
}
