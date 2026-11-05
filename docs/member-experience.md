# Member lobby, support and language release

Home and Games share the implemented-game catalogue. Unfinished and retired games
are hidden. Implemented games retain their server availability gate. Home previews
six authorized provider games; selecting one validates the current catalogue and
launch readiness before opening Casino. Rendering a preview does not launch a game.

## Group play

Only Spin, Turbo Keno and Dice currently implement group entries, shared outcomes,
settlement, cancellation and refunds. The other original games remain solo.
Group play uses noncash GAME_POINTS and the existing 93% pool / 7% points fee rules.
Do not treat practice ETB, provider test ETB and GAME_POINTS as interchangeable.

When GROUP_PVP_GAME_POINTS_ENABLED=true, the API runs a dedicated, non-overlapping
group tick loop. New entries and starts require a successful recent tick. Refund
and cancel endpoints remain reachable through the existing ownership checks during
an outage. The existing practice worker continues to run the solo practice games.
The older group-pvp-worker must not be provisioned as an additional worker for this
release: it also starts unrelated lifecycle loops. Settlement remains transactional
and persisted in PostgreSQL.

## Support

Apply migration 20261105013000_member_support before deploying the web release.
Run node apps/api/dist/scripts/member-experience-check.js after migrations; it
checks support table permissions without creating tickets or changing balances.
Member requests are at /support, staff replies at /admin/support. Ticket data is
account-scoped, current account status and staff roles are checked server-side,
and mutations use request IDs. Unknown network failures preserve the exact request
for a safe retry. No email or Telegram message is sent by this feature.

AI assistance is optional. Configure OPENAI_API_KEY and SUPPORT_AI_MODEL privately
on the API service and redeploy. The model must be available to that OpenAI account.
The backend calls the Responses API with store=false, a 20-second timeout, a bounded
output and curated platform facts. Only the member's question and selected language
are sent; account records, balances and tickets are not added to the request.
The assistant cannot change accounts, payments or games. When configuration is
absent or the upstream fails, the UI directs users to guides and the support team.
An actual model response has not been validated without configured credentials.

## Languages

The header offers English, Amharic, Afaan Oromoo, Tigrinya, Somali, Arabic,
Swahili and French. These are supported Google Cloud Translation languages,
but this release uses local dictionaries, not a Google widget or translation API.
Navigation, lobby controls and common support controls are translated; game titles,
rules and some help text remain English. Arabic sets RTL. Selection is device-local.
Native-speaker review of translations remains recommended before wider rollout.

## Validation scope

Focused web tests cover discovery gating, casino deep links, group selection,
support retries and language preferences. Isolated PGlite tests cover ticket
ownership, staff authority, idempotency and untouched wallet sentinels; they do
not prove native PostgreSQL concurrency. Provider and group-rule regressions are
tested separately. Desktop and 390px phone layouts are inspected in a browser.
No production wager, withdrawal, deposit or support message is created for QA.
