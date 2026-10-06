/**
 * Canonical timezone strategy.
 *
 * SocialPlay uses UTC as the single platform-wide canonical timezone for
 * daily task periods and streak day boundaries. All client-supplied dates are
 * ignored; the server derives "today" from `new Date()` and formats it in UTC.
 *
 * Rationale: a single canonical timezone removes ambiguity around which
 * "day" a user is on, avoids per-user timezone drift, and makes streak/task
 * day boundaries deterministic and auditable.
 */

const UTC_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Format a Date into a canonical UTC calendar-day key (YYYY-MM-DD). */
export function utcDayKey(date: Date = new Date()): string {
  // Intl 'en-CA' yields YYYY-MM-DD in zoned formatting.
  return UTC_DAY_FORMATTER.format(date).replace(/\//g, '-');
}

/** Parse YYYY-MM-DD back into UTC midnight. */
export function utcMidnight(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Compute the previous day key relative to a given day key. */
export function previousDayKey(dayKey: string): string {
  const day = utcMidnight(dayKey);
  day.setUTCDate(day.getUTCDate() - 1);
  return utcDayKey(day);
}
