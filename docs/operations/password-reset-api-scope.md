# API-line reset-only candidate scope

Base: `3d8c9796292509e756e4f54e4ba2aa3e19fda753`, the docs-only successor to
`2b45b1b65ae7dd44dbee2c40ced51a789568da6d`. This describes source provenance,
not byte-level attestation of an executing production instance.

The release-based draft PR #79 at `e99c2bfa` must not be deployed wholesale as
an API hotfix. Its base `a54696e` differs from the API line in monitoring runtime,
provider callback handling and server setup. Those unrelated changes are **not**
part of this candidate.

The reset-only diff was applied to the API base without conflicts. Within
`apps/api/src`, only `auth/password-reset.ts` and its native test change. Exact
local comparison against the API base confirms no differences in:

- `apps/api/src/monitoring/`
- `apps/api/src/providers/`
- `apps/api/src/server.ts`

Additional changes are the reset-key configuration/example, reset migration,
reset regression configuration and credential-free migration fixture, dedicated
CI and rollout documentation. Independent static review confirmed the isolation.
The dedicated CI additionally runs existing monitoring/provider/support contracts.

This candidate neither imports nor modifies staff PR #77. Its blocked exact-head
integration remains unverified and has not been worked around. A later authorized
staff integration must preserve v2 issuance/consumption, independent key handling,
narrow return projections, and the existing credential-routing safeguards; do
not choose one branch's complete reset file blindly during conflict resolution.

The API-only approach keeps dormant staff work separate and avoids making this
security repair depend on activating staff access. It does not authorize live
access, production migration/grants/keys, merge, or deployment. Existing global
reset block, drain, role, secret, exact-candidate CI and approval gates still apply.
