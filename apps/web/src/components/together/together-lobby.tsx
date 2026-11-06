import { togetherGame, type TogetherRoundView } from '@socialplay/shared';
import { useTogetherText } from '@/lib/i18n/together-text';
import { GameArena } from '@/components/games/game-arena';
import { GAME_ART_DIRECTION } from './game-art-direction';
import { DrawStage } from './draw-stage';
import { BlackjackStage, DiceStage, NumberStage } from './table-stages';
import { SharedWheel } from './shared-wheel';
import { RaceBroadcast2D, PitchBroadcast2D } from './lightweight-sports';
import { FlightStage } from './flight-stages';
import './together-live-game.css';
import './shared-stages.css';
import './group-arena.css';

/** An idle arena preview. It cannot confirm an entry or start a game. */
export function TogetherLobby({
  round,
  userId,
  serverNow,
}: {
  round: TogetherRoundView;
  userId: string;
  serverNow: number | null;
}) {
  const { t, num, money } = useTogetherText(),
    art = GAME_ART_DIRECTION[round.game];
  const entries = round.entries
    .filter((e) => e.state === 'ACCEPTED')
    .sort((a, b) => a.id.localeCompare(b.id));
  const mine = entries.find((e) => e.userId === userId),
    seconds =
      serverNow === null ? null : Math.max(0, Math.ceil((round.closesAt - serverNow) / 1000));
  return (
    <section className="tg-live" data-skin={art.skin} aria-label={t('Shared game screen')}>
      <GameArena title={togetherGame(round.game).name} className="tg-arena-display">
        <div className="tg-lobby-stage" data-stage={art.stage}>
          {art.stage === 'race' && (
            <RaceBroadcast2D
              positions={Array(8).fill(0)}
              elapsed={0}
              reduced
              dogs={round.game === 'neon_hounds_3d'}
            />
          )}
          {art.stage === 'football' && <PitchBroadcast2D elapsed={0} reduced />}
          {art.stage === 'draw' && (
            <DrawStage
              game={round.game}
              balls={[]}
              picks={mine?.selection ?? []}
              elapsed={0}
              reduced
            />
          )}
          {art.stage === 'cards' && <BlackjackStage events={[]} elapsed={0} />}
          {art.stage === 'dice' && (
            <DiceStage entries={entries} events={[]} elapsed={0} reduced running={false} />
          )}
          {art.stage === 'number' && (
            <NumberStage target={null} entries={entries} elapsed={0} reduced />
          )}
          {art.stage === 'wheel' && <SharedWheel entries={entries} winner={null} progress={0} />}
          {art.stage === 'flight' && (
            <FlightStage
              sky={round.game === 'sky_crash'}
              elapsed={0}
              duration={42000}
              running={false}
              complete={false}
              result={null}
              target={mine?.selection?.[0] ?? null}
              reduced
              connected
            />
          )}
          <div className="tg-lobby-overlay">
            <div>
              <h2>{round.state === 'OPEN' ? t('Entries open') : t('Preparing the round')}</h2>
              <p>{t('Watching is free. Only confirmed entries participate financially.')}</p>
            </div>
            {round.state === 'OPEN' && seconds !== null && (
              <strong role="timer">
                {num(Math.floor(seconds / 60))}:
                {num(seconds % 60, { minimumIntegerDigits: 2, useGrouping: false })}
              </strong>
            )}
          </div>
        </div>
      </GameArena>
      <div className="tg-arena-ticket">
        <span>
          <b>{t('{count} confirmed', { count: entries.length })}</b>
          <small>{mine ? t('Your confirmed entry') : t('Watching is free')}</small>
        </span>
        <span>
          <small>{t('Funded pool')}</small>
          <b>{money(entries.length * round.entryAmount, round.currency)}</b>
        </span>
      </div>
    </section>
  );
}
