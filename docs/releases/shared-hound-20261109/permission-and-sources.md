# Shared runner 1: source and permission record

> **Superseded on 2026-11-11 (local branch `claude/optimistic-pascal-yn3kf0`).** This
> candidate was never pushed or released. Its files were recovered from a surviving
> source archive and committed unchanged; the next commit retired the runner-1 2D
> artwork (PNG, NOTICE, loader and atlas review scripts) when every runner moved to the
> original procedural greyhound. The shared finish-line correction and the graphics
> failure/cleanup hardening were kept. The record below is preserved as history; see
> `docs/releases/greyhound-realism-20261111/README.md`.

This candidate uses the exact greyhound image accepted from local preview
`dfcdfdf01e344abb7cc1e503871597e5acb90bf7`. It does not include that preview's
ancestry, sculpted greyhound, public runner-one GLB, corgi, Mesh2Motion code or
other animal experiments.

## Actual permission evidence

The question in the owner conversation was:

> Where did you obtain the dog-racing archive, and do you have a license allowing its code and artwork to be used in Salem Bet? It contains CodeThisLab credits but no game license. I can continue with the licensed soccer code while this is clarified.

The owner's answer was:

> yes

The owner then requested reuse of the supplied code. For this release, the
coordinating conversation supplied this acceptance:

> i think it's enough, check and deploy it...since this is a group game, maybe we will update it for the feature

This records the owner's affirmation of existing permission for the requested
Salem Bet use, followed by acceptance for release. The candidate is a commercial
browser-delivery use of that same artwork: the PNG is served to members' browsers.
It relies on that affirmation. The answer did not name the original source,
provide a receipt, identify a license edition, or state redistribution and
attribution conditions. Those underlying terms have not been independently
verified. This record is not a new license, a legal opinion or proof of copyright
ownership. No additional rights are inferred from the archive being available
online; it is not described as open source. Preserve the owner's license record
with the operator's release records if available.

CodeThisLab credit is retained in the source comment and publicly shipped
`images/dog-racing/NOTICE.txt`. No new agreement, purchase, external contact or
denied download was used to prepare this candidate.

## Exact inputs

| Input                               |      Bytes | SHA-256                                                            |
| ----------------------------------- | ---------: | ------------------------------------------------------------------ |
| Supplied `dog_racing_game-main.zip` | 44,123,004 | `1bcf5065bb69c92eb61a7dad9a0964bd8d5c990b876298a1e00b3cf5e05e15d9` |
| `sprites/greyhound_1.png`           |    889,217 | `6e90ef05c059e683d53a1f4ffdaa6c4752e439007db578128020cf7f56922c01` |

The original atlas is 1352 × 1020 pixels, arranged in four columns and six rows.
Each frame is 338 × 170 pixels. CGreyhound declares running frames 0–21 and idle
frame 0. Frame 22 is excluded. Its independent 40 fps clock, random path changes,
winner detection, financial code and CreateJS runtime are not imported. Salem
selects an existing frame from already-disclosed lane distance instead.

The baked number 1 is why only shared runner 1 uses the image. The image bytes,
2.4-unit plane width and floor registration match the accepted preview. The
image has baked lighting and is smaller than the existing procedural dogs;
that accepted presentation remains visible in the matched release evidence.
No claim is made that runners 2–8 or other games received an artwork upgrade.

## Preparation and rebuilding

The PNG was copied without conversion from the accepted preview's
`apps/web/review/assets/user-greyhound/greyhound_1.png` to
`apps/web/public/images/dog-racing/shared-runner-one.png`.
No model build, paid API, remote runtime asset host or new dependency is needed.

```sh
python3 scripts/verify-shared-hound-assets.py
pnpm --filter @socialplay/shared build
pnpm --filter web build
```

To verify the original archive as well, supply its local path with `--archive`.
The verification script never extracts arbitrary paths or executes archive code.
If rebuilding from a fresh checkout, use the existing locked dependency setup;
the candidate does not change package manifests or the lockfile.

The atlas is excluded from the install precache and requested only for shared
racing in balanced/high quality. Low quality and solo racing do not request it.
Its base decoded RGBA storage is 5,516,160 bytes (about 5.26 MiB), without mipmaps.
That is a texture-size calculation, not a measured total GPU-memory cost.
