# SoftAggregator demo pilot

> Historical play-for-fun implementation. The current tester-only virtual-wallet
> pilot is documented in [softaggregator-test.md](softaggregator-test.md).

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

The adapter and operator probe use the same credential reader. It removes only
leading/trailing whitespace introduced when credentials are pasted into server
settings, rejects credentials that become empty, and uses the normalized password
for the anonymous player identity. Internal characters are preserved. Raw credentials
and provider session URLs are never emitted by the probe.

No salt key is needed: this pilot never connects the wallet. Leave the provider
callback unconfigured. Confirm with support that demo launches are enabled on the
account, are free, and do not require prepaid credit. Environment `prod` alone
does not establish sandbox access. Obtain the exact allowed launch hosts from
support; wildcards are intentionally unsupported. The API endpoint is fixed to
`https://api.softaggregator.com/api/v1`; credentials never go to a custom host or
HTTP redirect. The API emits only generic upstream failures.

Enable for a tester, then visit `/casino` after signing in. The older
`/games/provider-demos` address redirects to `/casino`. Our own games, including
solo practice and free games, remain in `/games`; group PVP stays inside groups. The page
lists only catalogue entries explicitly supporting play-for-fun. Check desktop
and phone launch, iframe compatibility, close/reopen, blocked non-demo titles,
provider zero-credit behavior, and unchanged application wallet/ledger. Do not
remove iframe restrictions to fix a game without reviewing its requirements.

Disable by setting `SOFTAGGREGATOR_DEMO_ENABLED=false`. Both catalogue and launch
check this gate and tester membership. Existing provider sessions may remain
open; revoke them with the provider if necessary. No provider credentials have
been used during implementation. Local tests mock the upstream API and do not
prove account entitlement, free access, or hosted game compatibility.

## Operator setup probe

The bundled `apps/api/dist/scripts/provider-demo-probe.js` is restricted to the
existing Salem API deployment target. It never connects an application wallet,
enables member access, approves a game host, or calls a real-money launch method.
An operator-funded production provider account can still use `getGameDemo` with
virtual balances; account funding does not configure Salem's server variables or
establish demo entitlement.

- `--check` reports configuration booleans and counts without contacting the
  provider. Incomplete optional configuration exits successfully so it cannot
  block an ordinary API deployment.
- `--catalogue` requires server-side credentials, calls only `getGameList`, and
  reports catalogue/demo counts. Upstream failures expose only a fixed status,
  HTTP status or bounded numeric provider error code.
- `--launch` requires credentials, selects the first valid demo-supporting game
  (or `SOFTAGGREGATOR_DEMO_PROBE_GAME_ID`), and requests one pseudonymous demo
  session. `SOFTAGGREGATOR_DEMO_PROBE_DEVICE` accepts `desktop` (default) or
  `mobile`. Only its validated HTTPS hostname is reported; the session URL is
  never logged or visited. Discovery is not host approval: review the hostname
  before configuring the existing exact member launch allowlist.
- `--tester` optionally resolves `SOFTAGGREGATOR_DEMO_TEST_USERNAME` using a
  read-only lookup of the existing user's opaque ID and active status. `--check`
  includes this lookup only when that variable is set. Username, name, email,
  passwords and wallet data are not logged. Keep opaque IDs in private operator
  logs; do not publish them in release notes.

The public-host check is syntactic and does not establish DNS ownership or
provider approval. Catalogue/launch probes do not require member feature gates
or an approved host list, allowing configuration to be checked before members
receive access. Missing credentials prevent all outbound provider requests.
Use fresh credentials stored on the API service only; no credentials are shipped
in the frontend or source tree.

## Initial implementation verification (historical)

These results describe the initial adapter milestone, before the current hosted
release. The current operator probe passes 66 provider tests and API typecheck/build;
actual provider credentials and hosted demo launches still require verification.

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

## Games and Casino navigation

The Games destination shows our complete non-retired catalogue, with optional
solo-practice and free-game filters and a link to group PVP. Casino shows only
provider demos. Own-game return links and the dashboard catalogue shortcut point
to Games, and the sidebar highlights the corresponding section.

Navigation verification: 185 focused web tests pass (20 catalogue/navigation,
3 actual App routing, 57 provider/Home/welcome and 105 existing game-page tests).
Web TypeScript/production build and 11 generated PWA checks pass. Existing
server availability gates and the provider tester gate remain in force.

## Initial navigation release review (historical)

Review fixes preserve 403/429 API errors with redacted messages and remove cached
provider titles/sessions when demo access is denied or its status request fails.
Four regressions failed before the fixes and pass after them: 20 isolated API
tests and 28 provider/Casino UI tests pass, as does web TypeScript.

The live `salem.bet` web service used the `c9c83afe` source base. Its API used
`17c773e2`, so the API adapter is released separately on that deployed base;
the full web feature branch is not promoted wholesale onto the older API.
The API release changes only provider adapter code, its registration and isolated
test setup. No database schema or migration changes are part of this release.
