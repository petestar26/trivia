# SoftAggregator virtual casino

This integration follows the provider's seamless-wallet test procedure: createPlayer
and getGame use the existing account API, while all test balances and movements
remain in the isolated sg_test_players and sg_test_movements tables. Player usernames
use a reserved st_ prefix and cannot map to a customer cash wallet. The provider's
commission credit is separate from the test player's virtual ETB balance.

The older getGameDemo adapter remains disabled. Its play-for-fun requirement does
not apply to this separate virtual-wallet integration.

## Configuration

API-only variables:

- SOFTAGGREGATOR_API_LOGIN and SOFTAGGREGATOR_API_PASSWORD: existing operator credentials.
- SOFTAGGREGATOR_SALT_KEY: current wallet callback salt, supplied through private settings.
- SOFTAGGREGATOR_TEST_ENABLED=true: allow new test launches/debits.
- SOFTAGGREGATOR_TEST_CALLBACK_ENABLED=true: accept signed callbacks for known test players.
- SOFTAGGREGATOR_TEST_ACCESS_MODE=all-active: automatically admit every authenticated
  ACTIVE account, including future registrations, without editing an account list.
  Omit it or use allowlist to retain the restricted pilot. Unknown values refuse
  access and report a setup problem. This setting never enables a cash wallet.
- SOFTAGGREGATOR_TEST_USER_IDS: comma-separated internal tester IDs. If omitted, reuse the
  existing SOFTAGGREGATOR_DEMO_USER_IDS list. These lists only apply in allowlist mode;
  keep them when switching modes so a deliberate restricted rollback remains possible.
- SOFTAGGREGATOR_TEST_LAUNCH_HOSTS: exact HTTPS hostnames verified from the provider's
  authenticated launch response. No arbitrary host or local-address fallback.
- Member launches and the CLI probe both use country ET. The old
  SOFTAGGREGATOR_TEST_COUNTRY setting no longer overrides that market.

WEB_CLIENT_IP_SOURCE=railway makes the existing web gateway sign Railway's X-Real-IP.
This deployment must be reached through Railway HTTP ingress; trusted private-network
callers are in the gateway trust boundary. The API independently requires the provider's
HMAC-SHA256 over all query fields, so source IP alone never authorizes a movement.

The public /sg/callback route proxies to the same bare API route without altering its
query. The API requires source IPv4 85.122.129.59, a timestamp within 30 seconds, the
documented MD5 key, and X-Signature. Seconds and milliseconds are accepted; the exact
raw timestamp is signed. Duplicate parameters and ambiguous canonical delimiters are
rejected. Failures return HTTP 200 with JSON error 2. Insufficient balance uses error 1.
The gateway also converts upstream failures to the provider's HTTP 200 error shape.
Provider query credentials are removed from application request logs.

## Test accounting

Opening balance: 1,000 virtual ETB (100,000 minor units), once per provisioned account.
No deposits, withdrawals, gifts, rewards, customer balances or financial ledger entries
are connected. All arithmetic uses integer minor units. A callback moves only the
explicitly provisioned test player's balance. Type is informational; unknown types,
retired game IDs, credits without matching debits and rollback debit/credit actions
are supported. Each call_id has one immutable receipt; a conflicting retry is refused.
Player-row locks serialize spending. A unique call_id also protects across players.
Deferred database checks reconcile balances to the opening grant plus accepted receipts.

Turning TEST_ENABLED off stops new launches and new debits, while exact retries and
credits can still settle. Disable CALLBACK_ENABLED only when all test sessions are
finished. No reset or cash conversion endpoint exists. Credential rotation may require
provider-assisted test-player password recovery before an existing player relaunches.

All member endpoints require a valid session and re-read the account's ACTIVE status
and session version on every request. Provisioning and debit callbacks also check
current account status. Automatic access does not bypass suspension, callback
signatures, approved launch hosts, or the separation from cash and reward balances.
The status response distinguishes paused service, restricted-account access and
incomplete setup; the lobby retries automatically and offers Check again.

## Verification and operator probe

Local tests execute the migration and service SQL in PGlite and mock only the external
provider. They cover cents, duplicate/conflicting retries, insufficient funds, bonuses,
rollback semantics, access revocation, immutable receipts and untouched cash fixtures.
PGlite serializes transactions; these checks are not native PostgreSQL load testing.
Route and gateway checks cover signatures, source attestation, HTTP 200 failures and
query redaction. UI checks cover the virtual wallet, Ethiopia launch market and restricted iframe.

provider-test-probe.js --check reports configuration booleans, the access mode and
the reason for unavailability. --launch still selects an active account from the
explicit tester list and makes one createPlayer/getGame sequence. It does not
place a bet or visit the returned session. Only the launch hostname and public game ID
are logged, with hostApproved showing whether the exact hostname is configured.
Set SOFTAGGREGATOR_TEST_GAME_ID to select a catalogue title. Run it only on the established API target, after the callback deployment is
healthy; keep ordinary readiness commands intact and restore them after the probe.

For an automatic-access rollout, deploy the supporting API first, then set
SOFTAGGREGATOR_TEST_ACCESS_MODE=all-active on the API service and verify the running
deployment reports that mode and TEST_CONFIGURED. Verify an existing member outside
the retained list can load the lobby. Regression tests cover new registrations after
server startup, signed-out/suspended/deleted accounts, revoked sessions, one-time
virtual balances, and pause/settlement behavior. No database migration is required.

The member Casino lobby now serves Ethiopia: the server sends country ET on every
member launch, independently of legacy client input. Provider country restrictions
remain enforced upstream. The operator CLI uses the same market.
The catalogue exposes validated HTTPS artwork, preferring image_portrait over image,
then image_square when neither is available. One distinct validated alternate image
is retained for a failed thumbnail before showing the local category fallback.
Portrait cards animate the supplied still artwork with a gentle pan/zoom; these are
not gameplay videos. Motion pauses off-screen, in hidden tabs, or via Pause previews.
Reduced-motion and data-saving preferences start previews still. No game sessions
are created by preview motion. Select a game tile to launch; search, category filters and Show more
make the full account catalogue browsable without opening games in the background.

## Catalogue and launch compatibility

The provider returns both a string session address and an object containing gameurl.
Both pass the same HTTPS, public-host syntax, credential and exact-host allowlist checks.
HTML, nested URLs, credentials in the authority, IP addresses and alternate ports are
refused. An authenticated provider response is required to discover a hostname;
do not use wildcard hosts or accept a browser-supplied address. Verify the exact
hostname through the operator probe before updating TEST_LAUNCH_HOSTS. A new provider
hostname still fails closed until configured; country/currency restrictions remain.

Failures expose stable safe codes for country restrictions, ETB incompatibility,
unconfigured addresses, timeouts and provider throttling. Operational warnings contain
only a fixed reason, method, numeric status/code and (for an unconfigured address) its
validated hostname. They never include player credentials, raw responses or session URLs.
The restricted iframe remains; members may explicitly open an approved returned URL
in a separate tab with no referrer or opener when embedding is incompatible.

The November 2026 catalogue mislabeled 17 of 21 Keno titles as slots or instant games.
The classifier normalizes genre metadata and repairs clear Keno, Bingo, table and Crash
title matches. A live table is also discoverable under Table games. Unknown genres
remain in More games; fishing-themed slots remain slots. Classification does not claim
that a title is launchable in a particular market. All valid catalogue IDs remain
browsable, with exact duplicate IDs removed and sportsbooks excluded. The lobby shows
category counts for the current search/provider filters, and Show more reaches every
matching result instead of silently truncating the catalogue.

Hosted acceptance still requires an Ethiopia-based tester to open a game at /casino,
place a virtual bet and confirm the debit/credit in Recent test wallet
activity. Provider iframe compatibility and a completed upstream bet/win are not
established by a successful API launch response alone.

Reference: https://softaggregator.com/docs.html (checked 2026-11-04).
