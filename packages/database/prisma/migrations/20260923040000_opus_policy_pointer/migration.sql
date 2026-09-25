-- M5: create one serialization row per country. Existing candidate thresholds
-- were not administrator-certified, so no pre-existing policy is activated.
-- This also fails closed for any unexpected legacy ENABLED version.
INSERT INTO "country_jurisdictions" ("countryCode", "activePolicyId")
SELECT c."code", NULL FROM "countries" c
ON CONFLICT ("countryCode") DO NOTHING;

UPDATE "country_casino_policies"
SET "state" = 'DISABLED',
    "status" = 'DISABLED',
    "disabledAt" = COALESCE("disabledAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "thresholdsConfiguredAt" IS NULL;

-- A manually preconfigured DRAFT row may exist on a replayed/populated DB.
-- It stays DRAFT until the serialized activation service performs all checks.
UPDATE "country_casino_policies"
SET "state" = 'DRAFT', "updatedAt" = CURRENT_TIMESTAMP
WHERE "thresholdsConfiguredAt" IS NOT NULL AND "state" IS NULL;

UPDATE "country_jurisdictions" SET "activePolicyId" = NULL, "updatedAt" = CURRENT_TIMESTAMP;

-- Ethiopia must remain disabled until all required thresholds are explicitly
-- configured and an administrator activates a new version.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "country_jurisdictions"
    WHERE "countryCode" = 'ET' AND "activePolicyId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Ethiopia casino policy unexpectedly active';
  END IF;
END;
$$;
