# Salem practice activation

Target: PlayQuibe Account Test, environment `account-test`
(`95bd9da5-59ea-4f49-b2b1-9114e8a1a0a2` / `e48c2274-6993-446e-8a54-c33e4d6f698e`).
Only the `account-api` service may run the scoped owner provisioning script.

## Prepared changes

- Publishes the actual Dice, Keno and Crash Point practice admission flags in the catalogue.
- Adds a separate Trivia practice API/UI using the active question bank with no reward, wallet, ledger, attempt or score writes. Existing reward-game contracts remain separate.
- Adds an opt-in worker for Dice, Keno, Number Challenge, Sky Crash, Crash Point, Derby, Football and Scheduled Spin, with independent loops, aggregate health, stale detection and graceful shutdown.
- Does not run group PVP or social lifecycle jobs. It does not activate Coin wagering, provider billing or transfers. Seven future game placeholders remain unavailable.

## Permission boundary

The proposed worker uses two fresh restricted logins:
`salem_practice_worker_20261104` for practice tables and Scheduled Spin, and
`salem_number_worker_20261104` for Number round creation/draw only.
Passwords are generated, stored on the API service and referenced by the worker;
no password belongs in Git or chat. SQL grants are transactional and refuse
wrong targets, unsafe or unrelated existing roles, financial table access,
user-sensitive columns, sequence access, schema creation, ownership and executable
non-trigger security-definer functions. No existing owner/staging guard is bypassed.

## Readiness before activation

Build the exact API release and run `practice-activation --check` as a predeploy
step. This reads only table/stream existence and current identity capabilities.
It does not create roles, grant privileges or enable streams. Existing migrations
are unchanged. The `--apply` operation additionally requires the exact activation
acknowledgment and two distinct 64-hex generated secrets; it provisions only the
scoped practice worker identities and enables the practice-only Spin stream.

Worker access and practice flags require the user's explicit approval after
automatic approval review rejected their configuration in this session. Until
then, the worker service remains unconfigured and disconnected from any source.
The readonly probe, catalogue repair and wallet-free Trivia can be deployed independently.

## Validation

67 isolated API tests pass, including19 real embedded-PostgreSQL privilege tests,
18 Trivia practice route tests,7 worker lifecycle tests,20 provider tests and
3 practice catalogue cases.83 focused UI/navigation tests and full web typecheck/
production build pass. API typecheck and bundle pass on the targeted release.
No practice worker activation or successful live round lifecycle is claimed
until the restricted credentials and flags are approved and acceptance is complete.
