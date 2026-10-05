import { PrismaClient } from '@prisma/client';
// Prisma's engine error logger can include query arguments before callers
// sanitize the error. Credential writes use a shared silent client instead.
export const credentialDb = new PrismaClient({ log: [] });
