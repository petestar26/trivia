import { footballSelectionLabel, footballSelectionShort } from '@/lib/i18n/game-labels';
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
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
  const { t: translateUi } = useInterfaceLanguage();

  const [group, setGroup] = useState<Group>('Main');
  const offer = useMemo(() => fixtureOffer(fixture.params), [fixture.params]);
  const names = useMemo(
    () => ({ home: clubById(fixture.homeClub).name, away: clubById(fixture.awayClub).name }),
    [fixture.homeClub, fixture.awayClub]
  );
  const markets = VF_MARKETS.filter((m) => m.group === group);
  return (
    <div className="vf-markets">
      <div className="vf-group-bar" role="group" aria-label={translateUi('Market groups')}>
        {GROUPS.map((g) => (
          <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>
            {translateUi(g)}
          </button>
        ))}
      </div>
      {markets.map((market) => {
        const selections = selectionsOf(market.key as MarketKey);
        return (
          <section key={market.key} className="vf-market" aria-label={translateUi(market.title)}>
            <header>
              <h4>{translateUi(market.title)}</h4>
              <details>
                <summary
                  aria-label={translateUi('Rules for {title}', {
                    title: translateUi(market.title),
                  })}
                >
                  {translateUi('Rules')}
                </summary>
                <p>{translateUi(market.rule)}</p>
              </details>
            </header>
            <div
              className={`vf-selections vf-selections--${market.key.toLowerCase()}`}
              role="group"
              aria-label={translateUi('{title} selections', { title: translateUi(market.title) })}
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
                        ? footballSelectionLabel(s, names, translateUi)
                        : translateUi('Not offered: price outside {value}–{value2}', {
                            value: formatOdds(VF_LIMITS.minOddsCents),
                            value2: formatOdds(VF_LIMITS.maxOddsCents),
                          })
                    }
                    aria-label={
                      available
                        ? translateUi('{selection}, price {price}', {
                            selection: footballSelectionLabel(s, names, translateUi),
                            price: formatOdds(cents),
                          })
                        : translateUi('{selection}, not offered', {
                            selection: footballSelectionLabel(s, names, translateUi),
                          })
                    }
                    onClick={() => cents !== null && onToggle(s.id, cents)}
                  >
                    <span>{footballSelectionShort(s, translateUi)}</span>
                    <b>{available ? formatOdds(cents) : '—'}</b>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      <p className="vf-fine">
        {translateUi(
          'Fixed prices include your stake and are set when the matchweek opens; they never change during it. Prices target a 90% average return on each market, rounded down to the hundredth.'
        )}
      </p>
    </div>
  );
}
