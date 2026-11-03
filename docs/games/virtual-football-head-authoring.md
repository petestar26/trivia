# Fictional football head asset foundation

The locally hosted `player-head-high.glb`, `player-head-mid.glb` and `player-head-low.glb` preserve the individually pinned CC0 MakeHuman core facial anatomy and add original fitted eye/iris/pupil geometry, tapered brow ribbons, eight facial/shape targets, vertex normals, UVs and semantic material IDs. They depict generic fictional people, with no photographed/scanned or named real-player likeness.

## Individually verified source

Only `makehuman/data/3dobjs/base.obj` from MakeHuman commit `a8bc2d54ff0ac92e78ff71431b1023eda42bf482` is imported. Its SHA-256 is `8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c`. The exporter refuses another byte sequence. This core asset is covered by that commit's [CC0 asset license](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.ASSETS.md), retained locally as `LICENSE-CC0.txt`. The pinned license and retained copy match SHA-256 `f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c`; the exporter verifies that retained license identity as well.

The [official core-asset policy](https://static.makehumancommunity.org/about/license.html) and [closed-source FAQ](https://static.makehumancommunity.org/mpfb/faq/use_in_closed_source.html) were checked on 2026-10-15. The latter explicitly distinguishes third-party assets with other licenses. No third-party texture, hair, face target, eye model, teeth, clothing, motion capture or application source was imported. MakeHuman/MPFB application code licensing is separate from the core asset. The new authoring/export/validation scripts are original repository code using the Python standard library.

`public/models/football/player-head-provenance.json` is the machine-readable source/version/license/export/hash manifest. It records every imported source (one), original additions, output SHA-256, byte size, topology counts, bounds, coordinate space, eye centers, semantic IDs and authoring limitations. No external runtime service is needed.

## Reproduction

Retrieve the exact pinned [core base.obj](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/makehuman/data/3dobjs/base.obj), retain it outside the shipped public directory, and run from the repository root:

```sh
python3 scripts/assets/build-football-heads.py path/to/base.obj --reuse-current-lods --check
python3 scripts/assets/validate-football-heads.py path/to/base.obj
```

The GLB writer embeds source identity in the asset extras. The shown check recreates attachment/morph bytes from the shipped mid/low facial surface prefixes and compares the complete current GLBs without rewriting them. Cold full LOD authoring is available without `--reuse-current-lods`; its floating-point inputs can produce different shading bytes from cached attachment revisions. No Blender installation or source application is necessary. Python 3.9 or later is sufficient.

| Export | Vertices | Triangles | Source facial triangles | Bytes |
| --- | ---: | ---: | ---: | ---: |
| high | 5,367 | 9,984 | 8,672, untouched | 1,376,156 |
| mid | 2,098 | 3,736 | 3,000 | 541,172 |
| low | 480 | 750 | 550 | 80,188 |

The original high facial topology is deliberately preserved despite exceeding an approximate 8k-triangle head target. Only hidden posterior eyeball surfaces are omitted. Original fitted eye caps/iris and raised brows with tapered fibre triangles add 1,312 triangles. The mid LOD uses original feature-weighted quadric collapse, prioritizing nose, lips, ear folds and eyelids, rejecting face flips, and retaining the pinned inner-lid loops. The low LOD is a distant-only mesh. It does not establish close-up quality.

## Runtime contract

Each GLB contains one mesh with one indexed primitive, `POSITION`, `NORMAL`, `TEXCOORD_0`, `_PART` and preview `COLOR_0`. It has eight relative `POSITION` morph targets and zero neutral weights. High and mid also include `NORMAL` deltas computed from each posed surface, so lighting follows the lid and facial deformation. Low keeps rest normals as a distant-only optimization. `mesh.extras.targetNames` supplies the order: `blinkLeft`, `blinkRight`, `jawOpen`, `browRaise`, `smile`, `noseWidth`, `lipFullness`, `earSize`. The runtime must preserve the morph arrays when making independent player meshes. Scaling an eye or merging only base positions will lose the fitted blink.

Positions are metres in the existing football world rest frame: `x = sourceX * .12`, `y = 1.50 + (sourceY - 5.89) * .12`, `z = (sourceZ - .161) * .12`. Positive Z is forward and positive Y is up. The metadata reference `(0, 1.66, 0)` denotes the cranial authoring reference; the production rig supplies its own head-joint pivot and inverse bind. Runtime binds these world-rest vertices directly. This is not a separate source skeleton; the runtime attaches the head to its own head bone.

| `_PART` | Meaning |
| ---: | --- |
| 0 | anatomical skin |
| 1 | lip vermilion |
| 2 | recessed lid/socket tissue |
| 3 | sclera/corneal spherical surface |
| 4 | iris |
| 5 | pupil |
| 6 | original fitted brow ribbon |
| 7 | mouth interior where present |

Pupils have explicit 2 mm radius boundaries with duplicated iris boundary vertices. `_IRIS` contains original analytic radial intensity variation; the runtime multiplies iris colors by it. Original fibre relief is only 0.02 mm. The preview colors distinguish the semantic groups; runtime PBR materials may replace them. UVs use a head cylindrical projection and should not be treated as imported photographic skin UVs. No texture is included in these assets.

Both eye centers are exported in extras and provenance: approximately `(±0.03693, 1.667298, 0.130122)` metres, radius `0.017598` metres, iris radius `0.0072` metres. The eye surface follows the source helper sphere and sits inside the actual source lid opening. The inner lid loops come from source vertices 7747–7772 and the corresponding mirrored coordinates; joint helper boxes were not used as lid positions.

`blinkLeft` closes the positive-X anatomical-left opening; `blinkRight` closes negative X. The existing eyelid vertices move to a subtly sloping seam around the corneal surface, with outer crease falloff. The eyeball, iris and pupil remain fixed. All weights are intended for `[0, 1]`; identity targets can vary within a small bounded range chosen by runtime. Combine expression weights conservatively: the authoring probes verify individual morph bounds, not every extreme combination.

## Evidence and limits

The independent validation reads the source and GLBs directly. It verifies valid buffers/accessors, finite attributes, indexed bounds, unit normals, high/mid normal deltas reconstructing unit posed normals and matching the actual deformed triangle surface within 0.002 per component (allowing Float32 cancellation at closed crease triangles), eight nonzero bounded targets, fixed ocular geometry across expressions, semantic groups, exact untouched high source positions/triangle order, mid preservation of each source inner-lid vertex, and aperture closure on both original lid loops in high and mid. Each neutral aperture is about 11.12 mm; a full blink leaves about 0.00262 mm of vertical aperture. Individual morph displacement is at most 30.15 mm for the full jaw target and approximately 3–10 mm for the identity targets.

Coordinate-level closure does not prove attractive rendered eyelid deformation or final player appearance. A genuinely rendered prototype must assess front/three-quarter/profile neutral and closed lids before roster integration. These assets are an anatomical foundation, not a scanned console-game asset package. Skin shading, scalp hairstyles, beard/lash detail and kits remain runtime responsibilities. The rendered brows and procedural skin can read as painted/stylized; this is not console-grade photorealism. The restrained jaw target does not include a dental/tongue or full lip-sync rig. There is no hair/cloth simulation or motion capture here. Desktop captures, browser performance and physical-device acceptance remain separate evidence.
