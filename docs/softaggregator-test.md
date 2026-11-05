# SoftAggregator virtual-wallet pilot

This integration follows the provider's seamless-wallet test procedure: createPlayer
and getGame use the existing account API, while all test balances and movements
remain in the isolated sg_test_players and sg_test_movements tables. Player usernames
use a reserved st_ prefix and cannot map to a customer cash wallet. The provider's
commission credit is separate from the test player's virtual ETB balance.

The older getGameDemo adapter remains disabled. Its play-for-fun requirement does
not apply to this separate, tester-restricted pilot.

## Configuration

API-only variables:

- SOFTAGGREGATOR_API_LOGIN and SOFTAGGREGATOR_API_PASSWORD: existing operator credentials.
- SOFTAGGREGATOR_SALT_KEY: current wallet callback salt, supplied through private settings.
- SOFTAGGREGATOR_TEST_ENABLED=true: allow new test launches/debits.
- SOFTAGGREGATOR_TEST_CALLBACK_ENABLED=true: accept signed callbacks for known test players.
- SOFTAGGREGATOR_TEST_USER_IDS: comma-separated internal tester IDs. If omitted, reuse the
  existing SOFTAGGREGATOR_DEMO_USER_IDS list; no access is granted to other users.
- SOFTAGGREGATOR_TEST_LAUNCH_HOSTS: exact HTTPS hostnames verified from the provider's
  authenticated launch response. No arbitrary host or local-address fallback.
- SOFTAGGREGATOR_TEST_COUNTRY: actual operator/test-player location for the CLI probe.

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

Opening balance: 1,000 virtual ETB (100,000 minor units), once per provisioned tester.
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

## Verification and operator probe

Local tests execute the migration and service SQL in PGlite and mock only the external
provider. They cover cents, duplicate/conflicting retries, insufficient funds, bonuses,
rollback semantics, access revocation, immutable receipts and untouched cash fixtures.
PGlite serializes transactions; these checks are not native PostgreSQL load testing.
Route and gateway checks cover signatures, source attestation, HTTP 200 failures and
query redaction. UI checks cover the virtual wallet, Ethiopia launch market and restricted iframe.

provider-test-probe.js --check reports configuration booleans only. --launch provisions
one allowlisted active tester and makes one createPlayer/getGame sequence. It does not
place a bet or visit the returned session. Only the launch hostname and public game ID
are logged. Run it only on the established API target, after the callback deployment is
healthy; keep ordinary readiness commands intact and restore them after the probe.

The member Casino lobby now serves Ethiopia: the server sends country ET on every
member launch, independently of legacy client input. Provider country restrictions
remain enforced upstream. The operator CLI retains its explicit actual-location setting.
The catalogue exposes validated HTTPS artwork, preferring image_portrait over image,
then image_square when neither is available. One distinct validated alternate image
is retained for a failed thumbnail before showing the local category fallback.
Portrait cards animate the supplied still artwork with a gentle pan/zoom; these are
not gameplay videos. Motion pauses off-screen, in hidden tabs, or via Pause previews.
Reduced-motion and data-saving preferences start previews still. No game sessions
are created by preview motion. Select a game tile to launch; search, category filters and Show more
make the full account catalogue browsable without opening games in the background.

Hosted acceptance still requires an Ethiopia-based tester to open a game at /casino,
place a virtual bet and confirm the debit/credit in Recent test wallet
activity. Provider iframe compatibility and a completed upstream bet/win are not
established by a successful API launch response alone.

Reference: https://softaggregator.com/docs.html (checked 2026-11-04).
