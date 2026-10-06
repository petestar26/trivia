-- M1: one enum change per migration. Forward-only.
ALTER TYPE "coin_provenance_type" ADD VALUE 'CONVERSION';
