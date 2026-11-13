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

## CI finding in the deposit candidate (not fixed here)

The first CI run on this branch (`9c5b169`) failed two native PostgreSQL steps on
PostgreSQL 13, 16 and 18. Migration apply and replay, including
`20261113060000_deposit_destination_revisions`, passed in both workflows.

- _Scheduled rounds PostgreSQL_, step "Payment lifecycle, authorization and recovery"
  (`vitest run src/agents src/withdrawals`): 10 files and 180 of 641 tests failed.
- _Play Together contracts_, step "Group financial contracts and restricted runtime
  permissions" (`vitest.together-native.config.ts`): 36 of 61 tests failed.

Cause: the candidate's change to `mintTestPurchasedCoins` in
`apps/api/src/test/financial-policy-fixtures.ts` (line 83) creates a payment method named
`'Synthetic receiving method'` on the shared `ZLP` test country for every call. The second
call in a database violates the `(countryId, type, name)` unique constraint (Prisma
`P2002`). Every error in the readable part of both logs is this violation. The log API
returns only the last 5,000 lines, so the earliest failing files in the payments step could
not be read. Other PRs on the same base pass both workflows, and the polish changes no API
file.

This is a test-fixture defect, not a production-code failure. A per-call name (for example
`` `Synthetic receiving method ${tag}` ``) is the likely one-line fix. That file is one of
the 38 candidate files, so fixing it means a new candidate revision. It was left unchanged
pending that decision.

## Remaining before release

1. Decide on the candidate fixture fix above and re-run CI.
2. Run the candidate's outstanding database gates on a fresh disposable PostgreSQL:
   migration `20261113060000_deposit_destination_revisions`, recovery rehearsal, the native
   payments suite and `scripts/deposit-safety-native.py`.
3. Check the shell on physical iOS and Android devices with a screen reader.
4. Get a native-speaker check of the long bottom-bar labels at 320px.
