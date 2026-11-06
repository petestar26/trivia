# Interface localization

The English message is the catalogue key. Every message has static Amharic,
Oromo, Tigrinya, Somali, Arabic, Swahili and French translations. Add a default
export satisfying `TranslationCatalog` in `catalogues/*.ts`; Vite bundles these
files locally. No translation service or runtime DOM rewriting is used.

Use `useLanguage().t('Hello {name}', { name })` for complete sentences. Keep
names, messages, codes, receipt IDs, cryptographic proofs and API payloads as
data. Translate source-owned status labels at their display boundary only.
Never translate a fragment such as the English plural suffix `s`.

Plural entries can provide `one`, `two`, `few`, `many` and `zero` in addition to
required `other`. Pass a numeric `count`; a sole numeric named parameter can
also select the plural category. Arabic supports all six categories. Every
translation must preserve its named parameters, except `count` may be omitted
in a plural form whose natural wording already expresses zero, one or two.

Use `formatNumber`, `formatCurrency` and `formatDate` from the hook for display.
Currency accepts major units (12.50 Birr), not minor units (1250 cents). Keep
calculation, serialization, input parsing and canonical evidence unchanged.
Use `formatMinorCurrency` for integer minor-unit amounts, including bigint or
decimal integer DTO strings; it retains exact precision for large balances.

For stored notifications, use `<LocalizedText message="Hello {name}"
values={{ name }} />` so open notices update when the language changes. Only
source-owned enum values may opt into `translateValues={["role"]}`; member
names, messages and other user content must never use that option.

Language changes preserve the component tree and unfinished form state. Arabic
sets document direction to RTL. The selected language persists in local storage
when available; unavailable storage affects only persistence.

Run `node apps/web/src/lib/i18n/tools/coverage.mjs --json /tmp/i18n-report.json`
from the repository root for a reachable-interface audit. `--strict` also fails
for missing message keys. English fallback is deliberately excluded from
coverage. The report separately lists dynamic metadata, raw JSX and runtime
fallbacks for review; these are not automatically considered translated.

`inventory.mjs` scans the import graph. `localize-jsx.mjs` is an offline migration
tool, dry-run by default, and requires reviewing its rich-content report. Do not
rerun the mutation while another contributor is manually editing interface copy.
