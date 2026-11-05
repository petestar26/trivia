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

AI assistance is optional. Set these variables privately on **account-api**, then
deploy. `SUPPORT_AI_MODEL` is a model identifier, not a key. Choose one provider:

| SUPPORT_AI_PROVIDER     | Secret variable    | Example SUPPORT_AI_MODEL            |
| ----------------------- | ------------------ | ----------------------------------- |
| groq                    | GROQ_API_KEY       | openai/gpt-oss-20b                  |
| openrouter              | OPENROUTER_API_KEY | openrouter/free                     |
| openai (legacy default) | OPENAI_API_KEY     | An available OpenAI Responses model |

Create a Groq key at https://console.groq.com/keys or an OpenRouter key at
https://openrouter.ai/settings/keys. Use a Groq Free plan to avoid paid usage;
the same Groq model can be billed on a paid account. OpenRouter accepts only
`openrouter/free` or an explicit `provider/model:free` variant here. Requests also
cap prompt, completion and per-request prices at zero. The free router selects
from available free models; a specific free variant gives more consistent behavior.
Free capacity and models can change. There are no automatic application retries
or cross-provider fallbacks, including to paid OpenAI.

Groq and OpenRouter use Chat Completions; legacy OpenAI uses Responses with
`store=false`. All requests use a 20-second timeout, bounded output and curated
platform facts. GPT-OSS on Groq uses low reasoning effort and omits reasoning from
the response. Only final assistant text is returned. OpenRouter excludes providers
that collect data (`data_collection=deny`); if no eligible free endpoint is available,
the request fails safely rather than relaxing the cost or data policy.

Only the member's question and selected language are sent with the curated facts;
account records, balances and tickets are not added. Provider data policies still
apply to text the member enters. The assistant cannot change accounts, payments or
games. Missing/invalid configuration, quota exhaustion, incomplete responses and
upstream errors direct members to guides and the support team. Mocked contract
tests cover all three adapters; a live answer still requires a configured key and
model. Native-speaker review is needed before relying on Ethiopian-language answers.

Provider references (checked 2026-11-05):

- https://console.groq.com/docs/quickstart
- https://console.groq.com/docs/reasoning
- https://console.groq.com/docs/rate-limits
- https://openrouter.ai/collections/free-models
- https://openrouter.ai/docs/guides/routing/provider-selection

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
