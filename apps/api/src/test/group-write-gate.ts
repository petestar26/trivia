import { prisma, type Prisma } from '@socialplay/database';

/**
 * A scoped, DETERMINISTIC pause inside the write of a group row, a membership
 * row, an invite row or a message row — the place a manager action stands AFTER
 * it has taken all of its locks and BEFORE it commits.
 *
 * "This request holds its locks and is about to write" is the state a reverse-order
 * schedule needs (the competing writer must be seen WAITING behind those locks),
 * and there is nothing left to hold that would park the request there: the rows it
 * writes are already its own. A pg_sleep() trigger would park it for a fixed time,
 * which proves nothing about ordering. This gate parks it on an advisory lock
 * instead — one the TEST holds, and releases when the test decides:
 *
 *   installWriteGate(NAME, 'MyGroupPrefix-')      once, in beforeAll
 *   await prisma.$transaction(async (tx) => {
 *     await holdWriteGate(tx, NAME, groupId);      the gate is closed for this group
 *     action = fire(...)                           it takes its locks, then parks in the trigger
 *     await waitForBlockedBackends(1, { queryLike: '%UPDATE "public"."group_members"%' })
 *     writer = fireCompetingWriter(...)            waits behind the action's locks (proven)
 *     await waitForBlockedBackends(1, { queryLike: MEMBER_ROWS_LOCK })
 *   })                                             commit: the gate opens
 *   removeWriteGate(NAME)                          once, in afterAll
 *
 * The trigger takes a SHARED advisory lock, so any number of writes pass through
 * an open gate together and never wait for each other; only the test's exclusive
 * hold parks them. It fires for rows of groups whose name starts with the given
 * prefix and for nothing else, so it cannot slow any other suite.
 *
 * A BEFORE ROW trigger runs after the statement has found and row-locked the row
 * (PostgreSQL locks the tuple to fetch its latest version before it calls the
 * trigger), so a parked UPDATE or DELETE already holds the row it writes; what the
 * action locked before its write (group, subject, actor, target) it holds too.
 */
export async function installWriteGate(name: string, groupNamePrefix: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe gate name: ${name}`);
  if (!/^[A-Za-z0-9_-]*$/.test(groupNamePrefix)) throw new Error(`unsafe group name prefix: ${groupNamePrefix}`);
  await removeWriteGate(name);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$
    DECLARE
      row_json jsonb;
      gid text;
    BEGIN
      IF TG_OP = 'DELETE' THEN row_json := to_jsonb(OLD); ELSE row_json := to_jsonb(NEW); END IF;
      IF TG_TABLE_NAME = 'groups' THEN gid := row_json->>'id'; ELSE gid := row_json->>'groupId'; END IF;
      IF EXISTS (SELECT 1 FROM groups g WHERE g.id = gid AND g.name LIKE '${groupNamePrefix}%') THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('${name}:' || gid, 0));
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$ LANGUAGE plpgsql
  `);
  for (const table of GATED_TABLES) {
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${name}_${table} BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`
    );
  }
}

/** Tables the gate watches. `messages` looks up its group the same way `group_members`/`group_invites` do (a `groupId` column) — see the trigger body above. */
const GATED_TABLES = ['group_members', 'group_invites', 'groups', 'messages'] as const;

export async function removeWriteGate(name: string): Promise<void> {
  for (const table of GATED_TABLES) {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name}_${table} ON ${table}`);
  }
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
}

/** Close the gate for one group until `tx` ends. */
export async function holdWriteGate(tx: Prisma.TransactionClient, name: string, groupId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${name}:${groupId}`}, 0))`;
}
