# SoftAggregator demo pilot

Demo-only integration, based on the provider's public `getGameList` / `getGameDemo`
documentation at https://softaggregator.com/docs.html (checked 2026-11-04).
No real-money launch, player creation, wallet callback, ledger writes or migrations.
The provider's demo balance is separate from Salem Bet practice balances.

## Setup

Rotate the password and salt exposed in the account screenshot before enabling.
Do not commit credentials, paste them in chat, or put them in VITE variables.
Set these variables on the API only:

```
SOFTAGGREGATOR_DEMO_ENABLED=true
SOFTAGGREGATOR_DEMO_USER_IDS=<comma-separated internal tester user IDs>
SOFTAGGREGATOR_API_LOGIN=<replacement login>
SOFTAGGREGATOR_API_PASSWORD=<replacement password>
SOFTAGGREGATOR_DEMO_LAUNCH_HOSTS=<exact HTTPS game hostnames confirmed by provider>
```

No salt key is needed: this pilot never connects the wallet. Leave the provider
callback unconfigured. Confirm with support that demo launches are enabled on the
account, are free, and do not require prepaid credit. Environment `prod` alone
does not establish sandbox access. Obtain the exact allowed launch hosts from
support; wildcards are intentionally unsupported. The API endpoint is fixed to
`https://api.softaggregator.com/api/v1`; credentials never go to a custom host or
HTTP redirect. The API emits only generic upstream failures.

Enable for a tester, then visit `/games/provider-demos` after signing in. The page
lists only catalogue entries explicitly supporting play-for-fun. Check desktop
and phone launch, iframe compatibility, close/reopen, blocked non-demo titles,
provider zero-credit behavior, and unchanged application wallet/ledger. Do not
remove iframe restrictions to fix a game without reviewing its requirements.

Disable by setting `SOFTAGGREGATOR_DEMO_ENABLED=false`. Both catalogue and launch
check this gate and tester membership. Existing provider sessions may remain
open; revoke them with the provider if necessary. No provider credentials have
been used during implementation. Local tests mock the upstream API and do not
prove account entitlement, free access, or hosted game compatibility.

## Verification (2026-11-04)

- 18 isolated API tests and 6 demo page tests passed with mocked provider calls.
- 51 Home/welcome regression tests and 11 generated PWA checks passed.
- Shared packages, production web build (including TypeScript) and API bundle passed.
- Full API typecheck reports two diagnostics in the unchanged
  `src/games/game-practice-availability.test.ts` (lines 6 and 18). API typecheck
  excluding only that existing test file passes, including the new integration tests.
- No provider credentials were used, no provider sessions launched, and no hosted
  deployment, wallet callback configuration or account credit changes were made.
- Real browser/provider acceptance remains pending; DOM tests do not establish
  iframe compatibility or provider demo entitlement. Build runtime: Node 24.22.1;
  repository API bundle target remains Node 20.
