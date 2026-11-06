import * as Dialog from '@radix-ui/react-dialog';
import {
  VF_LIMITS,
  VF_MARKETS,
  VF_RETURN_PERCENT,
  VF_RULES_DIGEST,
  VF_RULES_ID,
  VF_TIMING,
} from '@socialplay/shared';
import { formatCredits, formatOdds } from '@/lib/football/format';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

const seconds = (ms: number) => `${ms / 1000} s`;

export function RulesDialog() {
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <Dialog.Root>
      <Dialog.Trigger className="vf-help">{translateUi('How it works ↗')}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="vf-overlay" />
        <Dialog.Content className="vf-dialog vf-dialog--rules" aria-describedby="vf-rules-desc">
          <Dialog.Title>{translateUi('Salem Bet Football: rules')}</Dialog.Title>
          <Dialog.Description id="vf-rules-desc">
            {translateUi(
              'An original simulated league using free, non-redeemable practice ETB. It is not connected to any real club, league or competition.'
            )}
          </Dialog.Description>
          <h3>{translateUi('The league')}</h3>
          <p>
            {translateUi(
              'Premier League club names identify twenty simulated teams, with original badges and kits. These are not real fixtures, players or club ratings. The virtual teams play a fixed double round-robin: 38 matchweeks of {fixturesPerWeek} matches per season, and every club meets every other club home and away. A new matchweek starts every five minutes.',
              { fixturesPerWeek: VF_TIMING.fixturesPerWeek }
            )}
          </p>
          <ol>
            <li>
              {translateUi('Selections are open for {value}.', {
                value: seconds(VF_TIMING.selectionMs),
              })}
            </li>
            <li>
              {translateUi(
                'First half {value}, half-time {value2}, second half {value3}: a 90-minute match compressed to {value4}.',
                {
                  value: seconds(VF_TIMING.firstHalfMs),
                  value2: seconds(VF_TIMING.halftimeMs),
                  value3: seconds(VF_TIMING.secondHalfMs),
                  value4: seconds(VF_TIMING.matchMs),
                }
              )}
            </li>
            <li>
              {translateUi(
                'Results and the table stay on screen for {value} before the next matchweek opens.',
                { value: seconds(VF_TIMING.resultsMs) }
              )}
            </li>
          </ol>
          <p>
            {translateUi(
              'A matchweek is created during its selection window while this practice league is running. Missed matchweeks are shown as not played; their results are never made up afterwards.'
            )}
          </p>
          <h3>{translateUi('Tickets')}</h3>
          <ul>
            <li>
              {translateUi(
                'A ticket holds up to {maxLines} lines: singles, and multiples of {minLegsPerMultiple} to {maxLegsPerMultiple} selections from different matches, every one of which must win.',
                {
                  maxLines: VF_LIMITS.maxLines,
                  minLegsPerMultiple: VF_LIMITS.minLegsPerMultiple,
                  maxLegsPerMultiple: VF_LIMITS.maxLegsPerMultiple,
                }
              )}
            </li>
            <li>
              {translateUi(
                'Stake {minLineStake}–{maxLineStake} ETB per line, up to {value} per ticket and {maxTicketsPerMatchweek} tickets per matchweek.',
                {
                  minLineStake: VF_LIMITS.minLineStake,
                  maxLineStake: VF_LIMITS.maxLineStake,
                  value: formatCredits(VF_LIMITS.maxTicketStake),
                  maxTicketsPerMatchweek: VF_LIMITS.maxTicketsPerMatchweek,
                }
              )}
            </li>
            <li>
              {translateUi(
                'Combined odds are capped at {value}×, a line returns at most {value2} ETB and a ticket at most {value3}.',
                {
                  value: formatOdds(VF_LIMITS.maxCombinedOddsCents),
                  value2: formatCredits(VF_LIMITS.maxLineReturn),
                  value3: formatCredits(VF_LIMITS.maxTicketReturn),
                }
              )}
            </li>
            <li>
              {translateUi(
                'A winning line returns stake × the product of its prices, rounded down once to a whole credit. A losing line returns 0.'
              )}
            </li>
            <li>
              {translateUi(
                'Confirmed tickets cannot be changed, cancelled or cashed out. There is no autoplay and no jackpot.'
              )}
            </li>
            <li>
              {translateUi(
                'Pressing confirm twice, or retrying after a lost connection, can never charge you twice: each confirmation has a receipt key, and the same ticket always returns the same receipt.'
              )}
            </li>
          </ul>
          <h3>{translateUi('How results and prices are made')}</h3>
          <p>
            {translateUi(
              'Each match is generated by the server from a secret seed that is committed (hashed) before selections open and revealed after the matchweek. The same finite model produces both the result and the prices: a score with six goals or fewer, with goal times in order. After full time you can verify every result in your browser.'
            )}
          </p>
          <p>
            {translateUi(
              "Prices are fixed when the matchweek opens and never move. Each is {VF_RETURN_PERCENT}% of the fair price implied by the model's probability, rounded down to the hundredth, so every market returns about {VF_RETURN_PERCENT}% on average. A selection whose price would fall below {value} or above {value2} is shown as not offered. Club strength is public, but results are random: form and previous matches do not predict the next one.",
              {
                VF_RETURN_PERCENT: VF_RETURN_PERCENT,
                value: formatOdds(VF_LIMITS.minOddsCents),
                value2: formatOdds(VF_LIMITS.maxOddsCents),
              }
            )}
          </p>
          <p>
            {translateUi(
              "The match animation is a decorative replay of goals the server has already released. Players' movement between goals is illustrative and never affects any result or price."
            )}
          </p>
          <h3>{translateUi('Markets')}</h3>
          <dl className="vf-rules-markets">
            {VF_MARKETS.map((m) => (
              <div key={m.key}>
                <dt>{m.title}</dt>
                <dd>{m.rule}</dd>
              </div>
            ))}
          </dl>
          <p className="vf-fine">
            {translateUi(
              'Rules {VF_RULES_ID} · digest {value}… Practice ETB are free, cannot be bought, transferred or redeemed, and have no connection to any cash value.',
              { VF_RULES_ID: VF_RULES_ID, value: VF_RULES_DIGEST.slice(0, 16) }
            )}
          </p>
          <Dialog.Close className="vf-secondary">{translateUi('Close rules')}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
