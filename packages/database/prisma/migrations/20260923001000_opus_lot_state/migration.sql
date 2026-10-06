-- M1: one enum change per migration. Forward-only.
CREATE TYPE "lot_state" AS ENUM ('OPEN', 'CONVERTED', 'EXHAUSTED', 'EXPIRED', 'RECLASSIFIED', 'FORFEITED');
