/** Explicit owner-only recovery, never called by API startup or a public route.
 * Output is a short-lived credential: capture privately, never in deployment logs. */
import { issueOwnerReset } from '../auth/password-reset.js';
import { credentialDb } from '../agents/credential-database.js';
const [userId, email] = process.argv.slice(2);
try {
  if (!userId || !email || process.argv.length !== 4)
    throw new Error('Exact account ID and email required');
  console.log(JSON.stringify(await issueOwnerReset(credentialDb, userId, email)));
} catch {
  console.error('OWNER_PASSWORD_RESET_REFUSED');
  process.exitCode = 1;
} finally {
  await credentialDb.$disconnect();
}
