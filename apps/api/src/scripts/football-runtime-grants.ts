import type { PrismaClient } from '@socialplay/database';

export const FOOTBALL_RUNTIME_GRANTS = Object.freeze([
  ['football_accounts', 'SELECT'],
  ['football_accounts', 'INSERT'],
  ['football_accounts', 'UPDATE'],
  ['football_tickets', 'SELECT'],
  ['football_tickets', 'INSERT'],
  ['football_tickets', 'UPDATE'],
  ['football_ticket_lines', 'SELECT'],
  ['football_ticket_lines', 'INSERT'],
  ['football_ticket_lines', 'UPDATE'],
  ['football_ticket_legs', 'SELECT'],
  ['football_ticket_legs', 'INSERT'],
  ['football_matchweeks', 'SELECT'],
  ['football_matchweeks', 'INSERT'],
  ['football_fixtures', 'SELECT'],
  ['football_fixtures', 'INSERT'],
] as const);

const TABLES = [
  'football_accounts',
  'football_matchweeks',
  'football_fixtures',
  'football_tickets',
  'football_ticket_lines',
  'football_ticket_legs',
] as const;
const IMMUTABLE = ['football_matchweeks', 'football_fixtures', 'football_ticket_legs'];
/** Privileges the runtime roles must never hold; checked by the staging command. */
export const FOOTBALL_FORBIDDEN_PRIVILEGES: ReadonlyArray<readonly [string, string]> = TABLES.flatMap(
  (table) => [
    [table, 'DELETE'] as const,
    [table, 'TRUNCATE'] as const,
    ...(IMMUTABLE.includes(table) ? ([[table, 'UPDATE']] as const) : []),
  ]
);

/**
 * Explicit staging/operator step, never invoked by normal API requests. Least privilege:
 * matchweeks, fixtures and legs are insert-only (immutable history, no UPDATE or DELETE);
 * only the account, ticket and line tables can be updated, for debits and settlement.
 */
export async function grantFootballRuntimeTables(db: PrismaClient, role: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) throw Error('Invalid runtime role');
  await db.$executeRawUnsafe(
    `GRANT SELECT,INSERT,UPDATE ON public.football_accounts,public.football_tickets,public.football_ticket_lines TO "${role}"`
  );
  await db.$executeRawUnsafe(
    `GRANT SELECT,INSERT ON public.football_matchweeks,public.football_fixtures,public.football_ticket_legs TO "${role}"`
  );
}
