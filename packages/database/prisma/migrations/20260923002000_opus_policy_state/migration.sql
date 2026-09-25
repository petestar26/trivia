-- M1: one enum change per migration. Forward-only.
CREATE TYPE "policy_state" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'DISABLED');
