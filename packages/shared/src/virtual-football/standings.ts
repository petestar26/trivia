import { VF_CLUBS } from './constants.js';

export interface FinishedMatch {
  homeClub: number;
  awayClub: number;
  ftHome: number;
  ftAway: number;
}
export interface StandingRow {
  position: number;
  club: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
}

/**
 * League table from completed official results only. 3/1/0 points. Ordering (documented
 * tie-break, applied in this exact order): points, goal difference, goals scored, wins,
 * then club name alphabetically (identical to ascending club id). Every club always
 * appears, with zeros at the start of a season.
 */
export function computeStandings(matches: Iterable<FinishedMatch>): StandingRow[] {
  const rows = new Map<number, StandingRow>(
    VF_CLUBS.map((club) => [
      club.id,
      { position: 0, club: club.id, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 },
    ])
  );
  for (const m of matches) {
    const home = rows.get(m.homeClub);
    const away = rows.get(m.awayClub);
    if (!home || !away) throw new RangeError('Unknown club in result');
    home.played++;
    away.played++;
    home.goalsFor += m.ftHome;
    home.goalsAgainst += m.ftAway;
    away.goalsFor += m.ftAway;
    away.goalsAgainst += m.ftHome;
    if (m.ftHome > m.ftAway) {
      home.won++;
      away.lost++;
      home.points += 3;
    } else if (m.ftHome < m.ftAway) {
      away.won++;
      home.lost++;
      away.points += 3;
    } else {
      home.drawn++;
      away.drawn++;
      home.points++;
      away.points++;
    }
  }
  const table = [...rows.values()];
  for (const row of table) row.goalDifference = row.goalsFor - row.goalsAgainst;
  table.sort(
    (a, b) =>
      b.points - a.points ||
      b.goalDifference - a.goalDifference ||
      b.goalsFor - a.goalsFor ||
      b.won - a.won ||
      a.club - b.club
  );
  table.forEach((row, i) => (row.position = i + 1));
  return table;
}
