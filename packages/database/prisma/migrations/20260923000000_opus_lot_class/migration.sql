-- M1: one enum change per migration. Forward-only.
CREATE TYPE "lot_class" AS ENUM ('WITHDRAWABLE', 'RESTRICTED', 'UNCLASSIFIED');
