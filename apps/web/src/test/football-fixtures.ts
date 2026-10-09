import {
  VF_RULES_DIGEST,
  VF_RULES_ID,
  VF_TIMING,
  clubById,
  computeStandings,
  cycleBySeasonWeek,
  fixtureCommitment,
  fixtureId,
  fixtureOffer,
  fixtureSeed,
  generateTimeline,
  liveFixture,
  matchweekCommitment,
  matchweekId,
  phaseAt,
  scheduledWeek,
  type FixtureParams,
  type Timeline,
  type VfFixtureView,
  type VfMatchweekView,
  type VfSnapshot,
  type VfTicketView,
} from '@socialplay/shared';

/**
 * Builds the exact public shapes the API returns, using the same shared functions the server
 * uses, so web tests exercise real prices, real commitments and real goal timelines.
 */
export const SEED = 'ab'.repeat(32);

export interface BuiltWeek {
  id: string;
  seasonNo: number;
  weekNo: number;
  timelines: Timeline[];
  fixtures: Array<{
    id: string;
    slot: number;
    homeClub: number;
    awayClub: number;
    params: FixtureParams;
    offerDigest: string;
    commitment: string;
  }>;
  commitment: string;
}

export function buildWeek(seasonNo: number, weekNo: number, seed = SEED): BuiltWeek {
  const id = matchweekId(seasonNo, weekNo);
  const fixtures = scheduledWeek(seasonNo, weekNo).map((f) => {
    const home = clubById(f.homeClub);
    const away = clubById(f.awayClub);
    const params: FixtureParams = {
      homeAttack: home.attack,
      homeDefence: home.defence,
      awayAttack: away.attack,
      awayDefence: away.defence,
    };
    const fid = fixtureId(id, f.slot);
    const offer = fixtureOffer(params);
    return {
      id: fid,
      slot: f.slot,
      homeClub: f.homeClub,
      awayClub: f.awayClub,
      params,
      offerDigest: offer.digest,
      commitment: fixtureCommitment(fid, fixtureSeed(id, fid, seed), offer.digest),
    };
  });
  const timelines = fixtures.map((f) => generateTimeline(fixtureSeed(id, f.id, seed), f.params));
  return {
    id,
    seasonNo,
    weekNo,
    timelines,
    fixtures,
    commitment: matchweekCommitment(
      id,
      fixtures.map((f) => f.commitment)
    ),
  };
}

export function weekView(built: BuiltWeek, serverTime: number, seed = SEED): VfMatchweekView {
  const cycle = cycleBySeasonWeek(built.seasonNo, built.weekNo);
  const elapsed = serverTime - cycle.kickoffAt;
  const revealed = serverTime >= cycle.fullTimeAt;
  return {
    id: built.id,
    seasonNo: built.seasonNo,
    weekNo: built.weekNo,
    opensAt: cycle.opensAt,
    kickoffAt: cycle.kickoffAt,
    halftimeAt: cycle.halftimeAt,
    secondHalfAt: cycle.secondHalfAt,
    fullTimeAt: cycle.fullTimeAt,
    endsAt: cycle.endsAt,
    commitment: built.commitment,
    seed: revealed ? seed : null,
    fixtures: built.fixtures.map((f, i): VfFixtureView => ({
      id: f.id,
      slot: f.slot,
      homeClub: f.homeClub,
      awayClub: f.awayClub,
      params: f.params,
      offerDigest: f.offerDigest,
      commitment: f.commitment,
      live: liveFixture(built.timelines[i].goals, elapsed),
    })),
  };
}

export interface SnapshotOptions {
  seasonNo?: number;
  weekNo?: number;
  /** Server milliseconds. Defaults to 20 s into the selection window. */
  serverTime?: number;
  balance?: number;
  tickets?: VfTicketView[];
  /** Whether the current matchweek exists (a week nobody opened is never created). */
  created?: boolean;
  mutate?: (snapshot: VfSnapshot) => void;
}

export function snapshotAt(options: SnapshotOptions = {}): VfSnapshot {
  const seasonNo = options.seasonNo ?? 1;
  const weekNo = options.weekNo ?? 5;
  const cycle = cycleBySeasonWeek(seasonNo, weekNo);
  const serverTime = options.serverTime ?? cycle.opensAt + 20_000;
  const current =
    options.created === false ? null : weekView(buildWeek(seasonNo, weekNo), serverTime);
  const previous = weekNo > 1 ? weekView(buildWeek(seasonNo, weekNo - 1), serverTime) : null;
  const finished = current && serverTime >= current.fullTimeAt ? current : previous;
  const matches = finished
    ? finished.fixtures.flatMap((f) =>
        f.live.fullTime
          ? [
              {
                homeClub: f.homeClub,
                awayClub: f.awayClub,
                ftHome: f.live.fullTime.home,
                ftAway: f.live.fullTime.away,
              },
            ]
          : []
      )
    : [];
  const snapshot: VfSnapshot = {
    rulesId: VF_RULES_ID,
    rulesDigest: VF_RULES_DIGEST,
    serverTime,
    balance: options.balance ?? 1000,
    cycle: {
      ...cycle,
      phase: (phaseAt(cycle, serverTime) === 'BEFORE' || phaseAt(cycle, serverTime) === 'AFTER'
        ? 'SELECTION'
        : phaseAt(cycle, serverTime)) as VfSnapshot['cycle']['phase'],
    },
    current,
    latestCompleted: finished && finished.fixtures.every((f) => f.live.fullTime) ? finished : null,
    viewed: null,
    standings: {
      seasonNo,
      weeksCompleted: finished && matches.length ? weekNo - (finished === current ? 0 : 1) : 0,
      rows: computeStandings(matches),
    },
    seasons: [{ seasonNo, weeksCompleted: 4 }],
    tickets: options.tickets ?? [],
  };
  options.mutate?.(snapshot);
  return snapshot;
}

export const openAt = (seasonNo: number, weekNo: number, secondsIn: number) =>
  cycleBySeasonWeek(seasonNo, weekNo).opensAt + secondsIn * 1000;
export { VF_TIMING };
