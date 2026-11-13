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

**Known harness issue:** `shell-qa.cjs` check `sportsbook-concurrent-consumers` fails on the
unmodified candidate as well as with the polish. It waits for the popup `page` event while
its own route gate holds the popup's first navigation. Playwright emits the popup event only
after that navigation, so the check can never complete. A non-deadlocking variant
(`evidence/member-shell-polish/concurrent.cjs`) confirms the targeted property on both
builds, three runs each: exactly one launch, and the other tab falls back to a manual click.
The original check has not been modified.

## Remaining before release

1. Run the candidate's outstanding database gates on a fresh disposable PostgreSQL:
   migration `20261113060000_deposit_destination_revisions`, recovery rehearsal, the native
   payments suite and `scripts/deposit-safety-native.py`.
2. Check the shell on physical iOS and Android devices with a screen reader.
3. Get a native-speaker check of the long bottom-bar labels at 320px.
4. Decide on a fix for the harness deadlock described above.
