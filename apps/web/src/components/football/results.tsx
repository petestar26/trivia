import { VF_CLUBS, clubById } from '@/lib/football/clubs';
import { useState } from 'react';
import {
  VF_LIMITS,
  VF_RULES_DIGEST,
  VF_RULES_ID,
  parseSelection,
  verifyMatchweek,
  type StandingRow,
  type VfMatchweekView,
  type VfSnapshot,
  type VfTicketView,
  type VfViewedWeek,
} from '@socialplay/shared';
import { ClubBadge } from './club-badge';
import { formatCredits, formatOdds } from '@/lib/football/format';
import { fixtureTeams, matchweekLabel, weekLabel } from '@/lib/football/fixtures';
import { displayFixture, matchweekRevealAt } from '@/lib/football/reveal';

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Re-derives every official goal from the revealed seed in this browser. */
export function VerifyResults({ week }: { week: VfMatchweekView }) {
  const [checked, setChecked] = useState<{
    identity: string;
    result: ReturnType<typeof verifyMatchweek>;
  } | null>(null);
  if (!week.seed) return null;
  const candidate = {
    matchweekId: week.id,
    seed: week.seed,
    commitment: week.commitment,
    fixtures: week.fixtures.map((f) => ({
      id: f.id,
      slot: f.slot,
      params: f.params,
      commitment: f.commitment,
      goals: f.live.events.map((g) => ({ n: g.n, side: g.side, half: g.half, atMs: g.atMs })),
    })),
  };
  // A verification badge applies only to the exact input that was checked, including
  // same-week changes. Never carry an earlier success into a newly loaded matchweek.
  const identity = JSON.stringify(candidate);
  const result = checked?.identity === identity ? checked.result : null;
  const run = () => setChecked({ identity, result: verifyMatchweek(candidate) });
  return (
    <div className="vf-verify">
      <button type="button" className="vf-secondary" onClick={run}>
        Verify these results in your browser
      </button>
      {result && (
        <p role="status" data-ok={result.ok}>
          {result.ok
            ? `Verified: all ${week.fixtures.length} matches were generated from the seed committed before kick-off.`
            : `Verification failed: ${result.problems.join('; ')}`}
        </p>
      )}
      <details>
        <summary>Commitment details</summary>
        <dl>
          <dt>Matchweek commitment</dt>
          <dd>
            <code>{week.commitment}</code>
          </dd>
          <dt>Revealed seed</dt>
          <dd>
            <code>{week.seed}</code>
          </dd>
          <dt>Rules</dt>
          <dd>
            <code>
              {VF_RULES_ID} · {VF_RULES_DIGEST.slice(0, 16)}…
            </code>
          </dd>
        </dl>
      </details>
    </div>
  );
}

function MatchweekResults({ week, serverNow }: { week: VfMatchweekView; serverNow: number }) {
  const elapsed = serverNow - week.kickoffAt;
  const complete = serverNow >= matchweekRevealAt(week);
  return (
    <>
      <ul className="vf-results" aria-label={`${weekLabel(week.seasonNo, week.weekNo)} results`}>
        {week.fixtures.map((fixture) => {
          const display = displayFixture(fixture.live, elapsed);
          const home = clubById(fixture.homeClub);
          const away = clubById(fixture.awayClub);
          const final = display.fullTime;
          return (
            <li key={fixture.id}>
              <div className="vf-result-row">
                <span className="vf-result-team">
                  <ClubBadge club={home.id} size={22} />
                  {home.name}
                </span>
                <b className="vf-result-score">
                  {final
                    ? `${final.home} – ${final.away}`
                    : display.score
                      ? `${display.score.home} – ${display.score.away}`
                      : 'v'}
                </b>
                <span className="vf-result-team vf-result-team--away">
                  {away.name}
                  <ClubBadge club={away.id} size={22} />
                </span>
                <small>
                  {final
                    ? `FT${display.halfTime ? ` · HT ${display.halfTime.home}–${display.halfTime.away}` : ''}`
                    : display.status === 'SCHEDULED'
                      ? 'Not started'
                      : display.minute}
                </small>
              </div>
              {display.events.length > 0 && (
                <details>
                  <summary>Goals ({display.events.length})</summary>
                  <ol>
                    {display.events.map((g) => (
                      <li key={g.n}>
                        {g.minute}&apos; ·{' '}
                        {clubById(g.side === 'H' ? fixture.homeClub : fixture.awayClub).name}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          );
        })}
      </ul>
      {complete && <VerifyResults week={week} />}
    </>
  );
}

export function ResultsPanel({
  snapshot,
  serverNow,
  weekView,
  onWeek,
  loading,
}: {
  snapshot: VfSnapshot;
  serverNow: number;
  /** The week being browsed, or null for the latest completed. */
  weekView: { seasonNo: number; weekNo: number } | null;
  onWeek: (target: { seasonNo: number; weekNo: number } | null) => void;
  loading: boolean;
}) {
  const viewed: VfViewedWeek | null = snapshot.viewed;
  const shown = weekView
    ? viewed && viewed.seasonNo === weekView.seasonNo && viewed.weekNo === weekView.weekNo
      ? viewed
      : null
    : null;
  const latest = snapshot.latestCompleted;
  const target =
    weekView ??
    (latest
      ? { seasonNo: latest.seasonNo, weekNo: latest.weekNo }
      : snapshot.cycle
        ? { seasonNo: snapshot.cycle.seasonNo, weekNo: snapshot.cycle.weekNo }
        : null);
  const go = (delta: number) => {
    if (!target) return;
    let index = (target.seasonNo - 1) * 38 + (target.weekNo - 1) + delta;
    if (index < 0) index = 0;
    onWeek({ seasonNo: Math.floor(index / 38) + 1, weekNo: (index % 38) + 1 });
  };
  const seasons = snapshot.seasons.length
    ? snapshot.seasons.map((s) => s.seasonNo)
    : [snapshot.cycle.seasonNo];
  const heading = target ? weekLabel(target.seasonNo, target.weekNo) : 'Results';
  const week = weekView ? (shown?.matchweek ?? null) : latest;
  return (
    <section className="vf-panel" aria-label="Results">
      <div className="vf-week-nav">
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="Previous matchweek"
          disabled={!target || (target.seasonNo === 1 && target.weekNo === 1)}
        >
          ‹
        </button>
        <div>
          <h3>{heading}</h3>
          {weekView === null && latest && <small>Latest completed matchweek</small>}
          {weekView !== null && (
            <button type="button" className="vf-link" onClick={() => onWeek(null)}>
              Back to latest
            </button>
          )}
        </div>
        <button type="button" onClick={() => go(1)} aria-label="Next matchweek" disabled={!target}>
          ›
        </button>
      </div>
      <div className="vf-week-pick">
        <label>
          Season
          <select
            value={target?.seasonNo ?? 1}
            onChange={(e) =>
              onWeek({ seasonNo: Number(e.target.value), weekNo: target?.weekNo ?? 1 })
            }
          >
            {[...new Set([...seasons, target?.seasonNo ?? 1])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  Season {n}
                </option>
              ))}
          </select>
        </label>
        <label>
          Matchweek
          <select
            value={target?.weekNo ?? 1}
            onChange={(e) =>
              onWeek({ seasonNo: target?.seasonNo ?? 1, weekNo: Number(e.target.value) })
            }
          >
            {Array.from({ length: 38 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                Week {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && <p role="status">Loading matchweek…</p>}
      {!loading && weekView && shown && shown.state === 'FUTURE' && (
        <>
          <p>This matchweek opens {when(shown.opensAt)}. Scheduled matches:</p>
          <ul className="vf-schedule">
            {shown.scheduled.map((f) => (
              <li key={f.slot}>
                {clubById(f.homeClub).name} v {clubById(f.awayClub).name}
              </li>
            ))}
          </ul>
        </>
      )}
      {!loading && weekView && shown && shown.state === 'NOT_PLAYED' && (
        <>
          <p>
            This matchweek was not played. A matchweek is only created when someone opens the game
            during its selection window, so no results exist for it. Scheduled matches:
          </p>
          <ul className="vf-schedule">
            {shown.scheduled.map((f) => (
              <li key={f.slot}>
                {clubById(f.homeClub).name} v {clubById(f.awayClub).name}
              </li>
            ))}
          </ul>
        </>
      )}
      {!loading && week && <MatchweekResults week={week} serverNow={serverNow} />}
      {!loading && !week && !weekView && <p>Completed matchweeks will appear here.</p>}
    </section>
  );
}

export function StandingsPanel({ snapshot, ready }: { snapshot: VfSnapshot; ready: boolean }) {
  const { standings } = snapshot;
  if (!ready)
    return (
      <section className="vf-panel" aria-label="League table">
        <p role="status">The table updates once the last goal of the matchweek has been shown.</p>
      </section>
    );
  const rows: StandingRow[] = standings.rows.length
    ? standings.rows
    : VF_CLUBS.map((c, i) => ({
        position: i + 1,
        club: c.id,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0,
      }));
  return (
    <section className="vf-panel" aria-label="League table">
      <h3>
        Season {standings.seasonNo} table{' '}
        <small>after {standings.weeksCompleted} of 38 matchweeks played</small>
      </h3>
      <div
        className="vf-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="League table, scrollable"
      >
        <table className="vf-table">
          <caption className="sr-only">Season {standings.seasonNo} league table</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Club</th>
              <th scope="col" title="Played">
                P
              </th>
              <th scope="col" title="Won">
                W
              </th>
              <th scope="col" title="Drawn">
                D
              </th>
              <th scope="col" title="Lost">
                L
              </th>
              <th scope="col" title="Goals for">
                GF
              </th>
              <th scope="col" title="Goals against">
                GA
              </th>
              <th scope="col" title="Goal difference">
                GD
              </th>
              <th scope="col" title="Points">
                Pts
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.club}>
                <td>{r.position}</td>
                <th scope="row">
                  <ClubBadge club={r.club} size={20} />
                  {clubById(r.club).name}
                </th>
                <td>{r.played}</td>
                <td>{r.won}</td>
                <td>{r.drawn}</td>
                <td>{r.lost}</td>
                <td>{r.goalsFor}</td>
                <td>{r.goalsAgainst}</td>
                <td>{r.goalDifference > 0 ? `+${r.goalDifference}` : r.goalDifference}</td>
                <td>
                  <b>{r.points}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="vf-fine">
        Three points for a win, one for a draw. Ties are split by goal difference, goals scored,
        wins, then club order. The table is built only from completed official results.
      </p>
    </section>
  );
}

function legLabel(fixtureId: string, selection: string) {
  const teams = fixtureTeams(fixtureId);
  const sel = parseSelection(selection);
  if (!teams || !sel) return selection;
  const names = { home: clubById(teams.homeClub).name, away: clubById(teams.awayClub).name };
  return `${clubById(teams.homeClub).code} v ${clubById(teams.awayClub).code} · ${sel.label(names)}`;
}

export function TicketsPanel({
  tickets,
  isRevealed,
}: {
  tickets: VfTicketView[];
  isRevealed: (ticket: VfTicketView) => boolean;
}) {
  if (!tickets.length)
    return (
      <section className="vf-panel" aria-label="My tickets">
        <p>
          Your confirmed tickets will appear here. Practice credits only: no Coins or cash prizes.
        </p>
      </section>
    );
  return (
    <section className="vf-panel" aria-label="My tickets">
      <ul className="vf-tickets">
        {tickets.map((ticket) => {
          const revealed = isRevealed(ticket);
          const settled = ticket.settledAt !== null && revealed;
          return (
            <li key={ticket.id}>
              <header>
                <h3>{matchweekLabel(ticket.matchweekId)}</h3>
                <span data-state={settled ? 'settled' : 'open'}>
                  {settled ? 'Settled' : 'Awaiting results'}
                </span>
              </header>
              <p>
                Stake {formatCredits(ticket.totalStake)} credits
                {settled ? ` · Returned ${formatCredits(ticket.totalReturn)} credits` : ''}
              </p>
              <ol>
                {ticket.lines.map((line) => (
                  <li key={line.lineNo}>
                    <div>
                      <b>{line.kind === 'SINGLE' ? 'Single' : `Multiple of ${line.legs.length}`}</b>
                      <span>
                        {formatCredits(line.stake)} credits · {formatOdds(line.combinedOddsCents)}×
                        {settled && line.payout !== null
                          ? ` · returned ${formatCredits(line.payout)}`
                          : ''}
                      </span>
                    </div>
                    <ul>
                      {line.legs.map((leg) => (
                        <li key={leg.fixtureId + leg.selection}>
                          <span>{legLabel(leg.fixtureId, leg.selection)}</span>
                          <b>{formatOdds(leg.oddsCents)}</b>
                          <i data-result={revealed ? leg.result : 'PENDING'}>
                            {revealed
                              ? leg.result === 'PENDING'
                                ? 'Pending'
                                : leg.result === 'WON'
                                  ? 'Won'
                                  : 'Lost'
                              : 'Pending'}
                          </i>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              <details>
                <summary>Receipt</summary>
                <dl>
                  <dt>Receipt hash</dt>
                  <dd>
                    <code>{ticket.receiptHash}</code>
                  </dd>
                  <dt>Request hash</dt>
                  <dd>
                    <code>{ticket.requestHash}</code>
                  </dd>
                  <dt>Rules</dt>
                  <dd>
                    <code>{ticket.rulesId}</code>
                  </dd>
                </dl>
              </details>
            </li>
          );
        })}
      </ul>
      <p className="vf-fine">
        Your 20 most recent tickets are shown (at most {VF_LIMITS.maxTicketsPerMatchweek} per
        matchweek). Confirmed tickets are immutable.
      </p>
    </section>
  );
}
