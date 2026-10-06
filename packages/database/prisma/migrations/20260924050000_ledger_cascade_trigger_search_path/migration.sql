-- Triggers a cascade can fire run as the table owner. PostgreSQL performs
-- the ON UPDATE / ON DELETE action of a foreign key as the owner of the
-- referencing table, and that table's own triggers then run with the
-- owner's privileges - even when the runtime role started it, by changing a
-- key (an Agent's id cascades to its orders and reservations) or deleting a
-- row (a policy's lots lose their policy). These trigger functions resolved
-- names in public, where an exact-type overload of a built-in (for example
-- to_jsonb(public.agent_orders), preferred to to_jsonb(anyelement)) or an
-- operator on the ledger's types, created by any role that can create
-- there, would run in their place as the owner. The setup refuses such a
-- role and such an object, but only when it runs; these functions no longer
-- depend on it.
--
-- Every trigger function bound to a table that a cascading foreign key
-- writes, on the event the cascade performs, now resolves names only in
-- pg_catalog and names this schema's tables and functions (built-ins
-- through pg_catalog). Their rules are unchanged, byte for byte apart from
-- those names. Invariant I3 derives the same set from the catalog and
-- reports any function in it without this pin, so a trigger added later
-- to such a table is reported too.
--
-- The functions are redefined here, forward, rather than in the migrations
-- that created them (20260923030000 to 20260924030000): several of those are
-- also on another branch.

-- Agent purchase proof (agents' and agent orders' ids cascade to orders,
-- reservations and settlements).
CREATE OR REPLACE FUNCTION "settled_agent_order_proof_immutable"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."agent_order_settlements" s WHERE s."orderId" = OLD."id")
     AND (pg_catalog.to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'settled Agent order purchase proof is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "settled_agent_reservation_proof_immutable"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."agent_order_settlements" s WHERE s."reservationId" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'settled Agent reservation purchase proof cannot be deleted';
    END IF;
    IF pg_catalog.to_jsonb(NEW) IS DISTINCT FROM pg_catalog.to_jsonb(OLD) THEN
      RAISE EXCEPTION 'settled Agent reservation purchase proof is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "financial_history_append_only"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; record a linked reversal', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "users_privilege_guard"()
RETURNS trigger AS $$
BEGIN
  IF pg_catalog.pg_has_role(current_user, (SELECT c."relowner" FROM pg_catalog.pg_class c WHERE c."oid" = TG_RELID), 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."role"::text <> 'USER' THEN
    RAISE EXCEPTION 'only the database owner creates a user with role %', NEW."role";
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."role" IS DISTINCT FROM OLD."role" OR NEW."status" IS DISTINCT FROM OLD."status") THEN
    RAISE EXCEPTION 'only the database owner changes a user''s role or status';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

-- Coin lots and accounts (coin_provenance, country_casino_policies and
-- users ids cascade to lots, their entries, allocations and accounts).
CREATE OR REPLACE FUNCTION "coin_lot_row_guard"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The entry INSERT trigger is the only writer of economic caches.
    IF (NEW."availableAmount", NEW."reservedAmount", NEW."requirementAmount", NEW."progressAmount")
       IS DISTINCT FROM
       (OLD."availableAmount", OLD."reservedAmount", OLD."requirementAmount", OLD."progressAmount")
       AND pg_catalog.pg_trigger_depth() < 2 THEN
      -- M7 may retire a genuinely pre-journal historical record once, at zero
      -- economic value, after replaying the wallet into new journalled lots.
      -- Its old amount, source and restriction fields remain untouched.
      IF NOT (
        OLD."sourceOperationId" IS NULL AND OLD."lotClass" IS NULL
        AND OLD."state" IS NULL AND OLD."availableAmount" IS NULL
        AND OLD."reservedAmount" IS NULL AND OLD."requirementAmount" IS NULL
        AND OLD."progressAmount" IS NULL
        AND NEW."lotClass" = 'UNCLASSIFIED' AND NEW."state" = 'RECLASSIFIED'
        AND NEW."availableAmount" = 0 AND NEW."reservedAmount" = 0
        AND NEW."requirementAmount" = 0 AND NEW."progressAmount" = 0
        AND NEW."sourceOperationId" IS NOT NULL
        AND NEW."amount" = OLD."amount"
        AND NEW."provenanceType" = OLD."provenanceType"
        AND NEW."restrictionStatus" = OLD."restrictionStatus"
        AND NEW."requiredPlaythrough" = OLD."requiredPlaythrough"
        AND NEW."completedPlaythrough" = OLD."completedPlaythrough"
        AND NEW."userId" = OLD."userId"
        AND EXISTS (
          SELECT 1 FROM public."economic_operations" op
          WHERE op."id" = NEW."sourceOperationId"
            AND op."type" = 'LEGACY_OPENING'
            AND op."scopeType" = 'WALLET_REPLAY'
            AND op."scopeId" = OLD."userId"
            AND op."userId" = OLD."userId"
        )
      ) THEN
        RAISE EXCEPTION 'coin lot caches are entry-maintained';
      END IF;
    END IF;
    -- New journal semantics supersede these old fields. Keep their historical
    -- values fixed, and create successor lots for any corrected value.
    IF OLD."sourceOperationId" IS NOT NULL AND (
         NEW."amount" IS DISTINCT FROM OLD."amount"
      OR NEW."restrictionStatus" IS DISTINCT FROM OLD."restrictionStatus"
      OR NEW."requiredPlaythrough" IS DISTINCT FROM OLD."requiredPlaythrough"
      OR NEW."completedPlaythrough" IS DISTINCT FROM OLD."completedPlaythrough"
      OR NEW."lotClass" IS DISTINCT FROM OLD."lotClass"
      OR NEW."sourceOperationId" IS DISTINCT FROM OLD."sourceOperationId"
      OR NEW."userId" IS DISTINCT FROM OLD."userId"
    ) THEN
      RAISE EXCEPTION 'managed coin lot origin fields are immutable';
    END IF;
    IF OLD."state" IN ('CONVERTED', 'EXHAUSTED', 'EXPIRED', 'RECLASSIFIED', 'FORFEITED')
       AND NEW."state" IS DISTINCT FROM OLD."state" THEN
      RAISE EXCEPTION 'terminal coin lot % cannot reopen', OLD."id";
    END IF;
    IF OLD."state" = 'OPEN' AND NEW."state" IS DISTINCT FROM OLD."state" THEN
      IF NEW."state" = 'CONVERTED' THEN
        IF NEW."lotClass" <> 'RESTRICTED' OR COALESCE(NEW."progressAmount", -1) < COALESCE(NEW."requirementAmount", 0)
           OR COALESCE(NEW."availableAmount", -1) <> 0 OR COALESCE(NEW."reservedAmount", -1) <> 0
           OR NOT EXISTS (SELECT 1 FROM public."economic_operations" o WHERE o."type" = 'BONUS_CONVERSION' AND o."scopeType" = 'LOT' AND o."scopeId" = NEW."id") THEN
          RAISE EXCEPTION 'invalid bonus conversion for lot %', NEW."id";
        END IF;
      ELSIF NEW."state" IN ('EXHAUSTED', 'RECLASSIFIED', 'FORFEITED') THEN
        IF COALESCE(NEW."availableAmount", -1) <> 0 OR COALESCE(NEW."reservedAmount", -1) <> 0 THEN
          RAISE EXCEPTION 'terminal lot % retains value', NEW."id";
        END IF;
      ELSIF NEW."state" = 'EXPIRED' THEN
        IF NEW."lotClass" <> 'RESTRICTED' OR NEW."expiresAt" IS NULL OR NEW."expiresAt" > CURRENT_TIMESTAMP
           OR COALESCE(NEW."availableAmount", -1) <> 0 OR COALESCE(NEW."reservedAmount", -1) <> 0 THEN
          RAISE EXCEPTION 'invalid expiry for lot %', NEW."id";
        END IF;
      ELSE
        RAISE EXCEPTION 'invalid lot state transition for %', NEW."id";
      END IF;
    END IF;
  END IF;
  IF NEW."lotClass" = 'WITHDRAWABLE' AND COALESCE(NEW."requirementAmount", 0) <> 0 THEN
    RAISE EXCEPTION 'withdrawable lot % has a playthrough obligation', NEW."id";
  END IF;
  IF NEW."lotClass" = 'UNCLASSIFIED' AND NEW."reviewId" IS NULL
     AND EXISTS (SELECT 1 FROM public."coin_ledger_accounts" a WHERE a."userId" = NEW."userId" AND a."classifiedAt" IS NOT NULL)
     AND COALESCE(NEW."availableAmount", 0) > 0 THEN
    RAISE EXCEPTION 'classified user has unreviewed unclassified lot %', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "coin_lot_initialization_guard"()
RETURNS trigger AS $$
BEGIN
  IF NEW."lotClass" IS NOT NULL AND (
       NEW."state" IS NULL OR NEW."availableAmount" IS NULL OR NEW."reservedAmount" IS NULL
       OR NEW."requirementAmount" IS NULL OR NEW."progressAmount" IS NULL) THEN
    RAISE EXCEPTION 'managed coin lot % is not fully initialized: its state and every cache must be set', NEW."id";
  END IF;
  IF NEW."lotClass" IS NULL AND (
       NEW."state" IS NOT NULL OR NEW."availableAmount" IS NOT NULL OR NEW."reservedAmount" IS NOT NULL
       OR NEW."requirementAmount" IS NOT NULL OR NEW."progressAmount" IS NOT NULL
       OR NEW."sourceOperationId" IS NOT NULL) THEN
    RAISE EXCEPTION 'coin lot % is partially initialized: a pre-journal lot keeps every ledger field NULL until replay', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "coin_lot_journal_integrity_guard"()
RETURNS trigger AS $$
DECLARE
  lot RECORD;
  op RECORD;
  sums RECORD;
BEGIN
  SELECT "id", "userId", "lotClass", "availableAmount", "reservedAmount",
         "requirementAmount", "progressAmount", "sourceOperationId"
    INTO lot FROM public."coin_provenance" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF lot."lotClass" IS NULL THEN RETURN NULL; END IF; -- pre-ledger row, not managed

  IF lot."sourceOperationId" IS NULL THEN
    RAISE EXCEPTION 'managed coin lot % has no source operation', lot."id";
  END IF;
  SELECT "id", "userId" INTO op FROM public."economic_operations" WHERE "id" = lot."sourceOperationId";
  IF NOT FOUND OR op."userId" <> lot."userId" THEN
    RAISE EXCEPTION 'managed coin lot % source operation is missing or cross-user', lot."id";
  END IF;

  SELECT COALESCE(pg_catalog.sum("availableDelta"), 0) AS available,
         COALESCE(pg_catalog.sum("reservedDelta"), 0) AS reserved,
         COALESCE(pg_catalog.sum("progressDelta"), 0) AS progress,
         COALESCE(pg_catalog.sum("progressDelta" + "obligationDelta"), 0) AS requirement
    INTO sums FROM public."coin_lot_entries" WHERE "lotId" = lot."id";

  IF lot."availableAmount" IS DISTINCT FROM sums.available
     OR lot."reservedAmount" IS DISTINCT FROM sums.reserved
     OR lot."progressAmount" IS DISTINCT FROM sums.progress
     OR lot."requirementAmount" IS DISTINCT FROM sums.requirement THEN
    RAISE EXCEPTION 'coin lot % caches do not reconcile with its ledger entries (value with no journal entry)', lot."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "coin_lot_owner_wallet_guard"()
RETURNS trigger AS $$
DECLARE
  owner TEXT;
BEGIN
  SELECT p."userId" INTO owner FROM public."coin_provenance" p WHERE p."id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."wallets" w WHERE w."userId" = owner) THEN
    RAISE EXCEPTION 'coin_provenance lot % belongs to user % who has no wallet', NEW."id", owner;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "coin_lot_review_coverage_guard"()
RETURNS trigger AS $$
DECLARE
  message TEXT;
BEGIN
  message := public."unclassified_lot_review_violation"(NEW."id");
  IF message IS NOT NULL THEN
    RAISE EXCEPTION '%', message;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "classified_wallet_lot_equality"()
RETURNS trigger AS $$
DECLARE
  uid TEXT;
  wallet_balance BIGINT;
  lot_balance BIGINT;
BEGIN
  uid := NEW."userId";
  IF NOT EXISTS (SELECT 1 FROM public."coin_ledger_accounts" a WHERE a."userId" = uid AND a."classifiedAt" IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT w."coinsBalance" INTO wallet_balance FROM public."wallets" w WHERE w."userId" = uid;
  SELECT COALESCE(pg_catalog.sum(p."availableAmount"), 0) INTO lot_balance
    FROM public."coin_provenance" p WHERE p."userId" = uid;
  IF wallet_balance IS NULL OR wallet_balance <> lot_balance THEN
    RAISE EXCEPTION 'classified wallet % imbalance: wallet %, lots %', uid, wallet_balance, lot_balance;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."coin_provenance" p
    WHERE p."userId" = uid AND (p."lotClass" IS NULL OR p."availableAmount" IS NULL OR p."reservedAmount" IS NULL)
  ) THEN
    RAISE EXCEPTION 'classified wallet % has uninitialized lot', uid;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "coin_allocations_frozen"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'coin_allocations is frozen; write coin_lot_entries instead';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "account_review_coverage_guard"()
RETURNS trigger AS $$
DECLARE
  lot RECORD;
  message TEXT;
BEGIN
  FOR lot IN
    SELECT p."id" FROM public."coin_provenance" p
    WHERE p."userId" = NEW."userId" AND p."lotClass" = 'UNCLASSIFIED'
    ORDER BY p."id"
  LOOP
    message := public."unclassified_lot_review_violation"(lot."id");
    IF message IS NOT NULL THEN
      RAISE EXCEPTION '%', message;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "coin_account_owner_wallet_guard"()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."coin_ledger_accounts" a WHERE a."userId" = NEW."userId") THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."wallets" w WHERE w."userId" = NEW."userId") THEN
    RAISE EXCEPTION 'coin_ledger_accounts row % belongs to user % who has no wallet', NEW."userId", NEW."userId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "wallet_ledger_owner_guard"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."userId" IS NOT DISTINCT FROM OLD."userId" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public."coin_ledger_accounts" a WHERE a."userId" = OLD."userId")
     OR EXISTS (SELECT 1 FROM public."coin_provenance" p WHERE p."userId" = OLD."userId") THEN
    RAISE EXCEPTION 'wallet of user % cannot be removed while it owns ledger rows', OLD."userId";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

-- Jurisdictions, contests, game sessions and platform gates (countries,
-- policies, games, challenges, groups and invariant runs cascade to them).
CREATE OR REPLACE FUNCTION "policy_pointer_guard"()
RETURNS trigger AS $$
DECLARE
  pointed RECORD;
BEGIN
  IF NEW."activePolicyId" IS NULL THEN RETURN NULL; END IF;
  SELECT "countryCode", "state", "thresholdsConfiguredAt" INTO pointed
    FROM public."country_casino_policies" WHERE "id" = NEW."activePolicyId";
  IF NOT FOUND OR pointed."countryCode" <> NEW."countryCode"
     OR pointed."state" <> 'ACTIVE' OR pointed."thresholdsConfiguredAt" IS NULL THEN
    RAISE EXCEPTION 'country % points to a non-active or foreign policy', NEW."countryCode";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "contest_rules_pin_guard"()
RETURNS trigger AS $$
BEGIN
  IF NEW."gameId" IS DISTINCT FROM OLD."gameId" OR NEW."rulesVersion" IS DISTINCT FROM OLD."rulesVersion" THEN
    RAISE EXCEPTION '% % is pinned to game % rules version %; its game and rules cannot change',
      TG_TABLE_NAME, OLD."id", OLD."gameId", OLD."rulesVersion";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "game_session_immutability_guard"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'game_sessions is append-only: session % is a committed replay record and cannot be deleted', OLD."id";
  END IF;
  RAISE EXCEPTION 'game_sessions is append-only: session % is a committed replay record and cannot change', OLD."id";
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "platform_gate_enable_guard"()
RETURNS trigger AS $$
BEGIN
  IF NEW."enabled" AND (TG_OP = 'INSERT' OR NOT OLD."enabled") THEN
    IF NEW."lastInvariantRunId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM public."invariant_check_runs" r
      WHERE r."id" = NEW."lastInvariantRunId" AND r."passed" AND r."finishedAt" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'gate % cannot enable without a passed invariant run', NEW."key";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
