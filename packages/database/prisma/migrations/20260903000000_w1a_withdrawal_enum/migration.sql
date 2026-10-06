-- W-1A: Add WITHDRAWAL to TransactionReferenceType
--
-- This is split into its OWN migration file, separate from the tables and
-- indexes that reference the new value. PostgreSQL does not allow a
-- newly-added enum value to be *used* (e.g. as a literal in an index WHERE
-- predicate) within the same transaction that performs the ALTER TYPE ...
-- ADD VALUE. Because Prisma runs each migration file inside a single
-- transaction, the ADD VALUE must commit in its own file before any index
-- that references 'WITHDRAWAL' is created in a later file.

ALTER TYPE "TransactionReferenceType" ADD VALUE 'WITHDRAWAL';
