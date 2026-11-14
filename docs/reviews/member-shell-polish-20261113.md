# Member and guest shell polish on the deposit-safety candidate

## Provenance

| Item                 | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| Base                 | `a54696ebc3805108f25a9e1a6555dbada8252c6f` (merge of PR #76)               |
| Deposit candidate    | `v7-derived-typefix-1`, 38 files, applied byte-exact as `b1f8049`          |
| Candidate manifest   | SHA-256 `d0b678842e279fd1796c120f672d61befe67e6f58e3c25252ec7ffdea3e6b1ef` |
| Candidate archive    | SHA-256 `de166e06c46400c82b5f14fbde2313b3b65863e55efffbc3950d2630633306fb` |
| Polish (this change) | `b407170`, 10 files, all under `apps/web/src`                              |

Before applying the candidate, the archive and manifest hashes were checked, along with
all 38 per-file hashes and the base preconditions (30 modified paths present at the base,
8 new paths absent, tsconfig original hash matching the manifest). No file was missing,
extra or mismatched. After copying, all 38 destination hashes matched again and only
those 38 paths differed from the base. The older v7 package was not used.

The polish commit touches none of the 38 candidate paths. The superseded standalone
Home/Discover redesign (`7e2d9de`, `/explore?pick=`, unrouted `pages/welcome.tsx`) was not
revived or reused.

Nothing was pushed to a production branch, merged or deployed. No real account, provider
session, bet, payment or funds movement was used. Browser checks used synthetic fixtures only.

## What changed (presentation only)

- **Bottom navigation (phones):** icons sit on one line even when a label wraps, labels are
  centered, and the active item uses an emerald tint and top bar at an unchanged weight, so
  labels never reflow. The focus ring is drawn inside each item so the screen edge cannot
  clip it.
- **Collection controls under 520px:** tabs share one row and search takes the full width.
  At 320px the search field was previously clipped. DOM and focus order are unchanged.
- **Loading:** a shared `LoadingState` (`role="status"`, translated `Loading…`) replaces the
  unlabeled spinners on Wallet, Rewards and Groups, the inline catalogue text and the
  session-probe screen. The member palette now applies while the probe is pending, which
  removes the light-theme flash on held deep links.
- **Fallbacks:** the session-check alert and the crash fallback get theme-adaptive cards.
  Text, roles and handlers are unchanged.
- **Detail:** guest category titles use the standard card weight, paragraphs use
  `text-wrap: pretty`, and tiles get an inset focus ring.
- **Motion:** an opacity-only page entrance and touch press feedback, both removed under
  `prefers-reduced-motion`. All new rules use logical properties for Arabic RTL, and no
  selector depends on translated text.

No API route, database schema, permission, wallet, deposit, hold, dispute, receiving-account
snapshot, game-availability gate or authentication flow changed.

## Verification

See `evidence/member-shell-polish/verification.txt` for the command list and results.
Screenshots are in the separately shared review board, not in the repository.

**Harness deadlock (fixed):** `shell-qa.cjs` check `sportsbook-concurrent-consumers` timed
out on the unmodified candidate as well as with the polish. It waited for the popup `page`
event before opening the second tab, while its own route gate held the popup's first
navigation until that second tab arrived. Playwright emits a popup only after its first
navigation, so the check could never complete. The check now listens on the opener's
`popup` event, opens the second tab, then awaits the popup. Its assertions are unchanged:
both tabs request the intent URL, exactly one launch, exactly one manual fallback. It
passes three runs each against the candidate build and the polish build. The standalone
variant `evidence/member-shell-polish/concurrent.cjs` checks the same property.

## CI finding in the deposit candidate (fixed as a separate revision)

The first CI runs on this branch (`9c5b169`, `4caa542`) failed two native PostgreSQL steps on
PostgreSQL 13, 16 and 18. Migration apply and replay, including
`20261113060000_deposit_destination_revisions`, passed in both workflows.

- _Scheduled rounds PostgreSQL_, step "Payment lifecycle, authorization and recovery"
  (`vitest run src/agents src/withdrawals`): 10 files and 180 of 641 tests failed.
- _Play Together contracts_, step "Group financial contracts and restricted runtime
  permissions" (`vitest.together-native.config.ts`): 36 of 61 tests failed.

Cause: the candidate's change to `mintTestPurchasedCoins` in
`apps/api/src/test/financial-policy-fixtures.ts` created a payment method named
`'Synthetic receiving method'` on the shared `ZLP` test country for every call. From the
second call in a database, that violated the `(countryId, type, name)` unique constraint
(Prisma `P2002`). A local PostgreSQL 16 reproduction matched CI exactly, and every failure
was this violation.

At the user's request this was fixed as a separately identified, test-only candidate revision,
**`v7-derived-typefix-1-fixture-1`** (commit `c8e5b4b`, 39-file manifest
`evidence/deposit-candidate/v7-derived-typefix-1-fixture-1.manifest.json`). The parent
`v7-derived-typefix-1` is unchanged at `b1f8049`. See `evidence/deposit-candidate/README.md`
for the change and the local before/after results.

## Remaining before release

1. Confirm CI for revision `v7-derived-typefix-1-fixture-2` (migration inventory entry) on
   PostgreSQL 13, 16 and 18, including steps 29-40 that were previously skipped.
2. Run the outstanding rehearsal gates on a fresh disposable PostgreSQL for whichever
   candidate identity is chosen: migration rehearsal, recovery rehearsal and
   `scripts/deposit-safety-native.py`.
3. Check the shell on physical iOS and Android devices with a screen reader.
4. Get a native-speaker check of the long bottom-bar labels at 320px.
