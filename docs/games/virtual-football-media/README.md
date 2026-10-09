# Virtual Football 3D: review media

Captured on 2026-10-09 in the review container, from the real page (API with the practice flag, group worker, throwaway database,
Vite dev server) driven by a scripted Chromium. Software GL (SwiftShader), no GPU, so the frames are legitimate pictures of the
feature but **not** device performance evidence. Phone shots are Chromium device emulation (390 × 844 at 2×), **not** an iPhone or Safari.
Nothing here shows a real club, player or competition: every name, kit and badge is original. These images are generated from this
repository's own 3D scene; no reference screenshot is included.

| File                                                  | What it shows                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-01-selections-open.webp`                     | Selections open: phase timer, pre-match stage, ten fixtures with full-time prices                                               |
| `desktop-02-markets-and-slip.webp`                    | Markets for one fixture; slip with four singles                                                                                 |
| `desktop-03-review-ticket.webp`                       | Review dialog: four singles and a multiple of three, totals and balance after confirming                                        |
| `desktop-04-first-half.webp`                          | First half; the score is 0–0 until a goal has been shown                                                                        |
| `desktop-05-goal-sequence.webp`                       | A goal being played out, scoreboard updated at the goal moment                                                                  |
| `desktop-06-results.webp`                             | Completed matchweek results, week navigation                                                                                    |
| `desktop-07-league-table.webp`                        | Derived league table with the tie-break note                                                                                    |
| `desktop-08-my-tickets.webp`                          | Settled tickets with line and leg results                                                                                       |
| `phone-01-stage.webp` … `phone-08-goal-sequence.webp` | The same flow on a phone: stage in the first screen, tray, keyboard-sized viewport, review, play, goal, results, table          |
| `goal-sequence-preview.mp4`                           | 5 s deterministic clip (30 fps): broadcast, cut to the goal, run-up, strike, keeper dive, ball in the net, cut back and restart |
| `live-play-preview.mp4`                               | 5 s of ordinary play at the broadcast camera                                                                                    |

The clips come from `apps/web/scripts/football-capture.mjs` (exact clock, same arguments give the same frames):

```
node apps/web/scripts/football-capture.mjs --start 5.4 --end 10.4 --goals 6000H --key vf-s1-w01-f05 --home 5 --away 14 --video goal-sequence-preview.mp4
node apps/web/scripts/football-capture.mjs --start 12 --end 17 --goals "" --key vf-s1-w01-f05 --home 5 --away 14 --video live-play-preview.mp4
```

A still frame cannot show gait. Use the clips, and the foot-contact assertions in `components/football/engine/poses.test.ts`, to judge
movement.
