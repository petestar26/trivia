# Selected core review-player surfaces

This review asset package processes only the official MakeHuman CC0 core pack's
`hair/short01`, `eyebrows/eyebrow001`, and
`skins/young_caucasian_male/young_lightskinned_male_diffuse.png`. The official
[core pack listing](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html)
identifies the pack as CC0. Every selected OBJ, material and fitting file also
explicitly declares its September 2020 CC0 release. The retained CC0 legal text
is `apps/web/public/models/football/LICENSE-CC0.txt`; exact source hashes, ZIP
entry CRCs and source holders are recorded in `review-player-provenance.json`.
`review-player-source-notices.txt` retains all five original material/fitting
license headers verbatim, with their source paths and exact source hashes.

The archive is pinned by its official URL, Last-Modified date 14 April 2024,
ETag `10bbb7ea-6160e7c0d7996`, byte length and central-directory hash. The downloader
retrieved selected byte ranges and verified decompressed entry CRCs and hashes.
It did not download the whole 280 MB archive, so no whole-archive hash is claimed.
The source skin material's internal name says `old_caucasian_male_detailed`
despite its young-male folder; the exact input identity is retained in provenance.
No unrelated asset-pack content, source application code, new purchase or AI
generated content is included.

`review-player-hair.glb` contains two named meshes: `review-hair` and
`review-brows`. The adapter triangulates source polygons, duplicates UV seams,
and computes smooth area-weighted normals by source vertex before seam splits.
The raw accessory OBJ positions are authoring coordinates for another neutral
shape. They are not a fit to the pinned base used by the review head.

The adapter evaluates each asset's licensed `.mhclo` vertex mappings against the
exact pinned `base.obj`: each zero-based base-vertex triple contributes its stored
barycentric weights, plus its stored XYZ offset multiplied by the corresponding
axis scale. Each axis scale is the separation of the two base vertices named by
`x_scale`, `y_scale` or `z_scale`, divided by that directive's denominator. Weights
and offsets retain the source precision; weights are not renormalized. The
`z_depth` directive controls render order/masking and never translates geometry.
This follows the documented [MHCLO format](https://static.makehumancommunity.org/oldsite/documentation/file_formats_and_extensions.html).
No MakeHuman application source is imported into the adapter.

Only then does the adapter apply the head's world transform:
`[x*.12, 1.50+(y-5.89)*.12, (z-.161)*.12]`. All 2,984 hair and 124 brow vertex
mappings are evaluated. The resulting neutral hair top is 1.83146m, about 1.93cm
above the 1.81216m skull; eyebrows span 1.67107–1.68619m immediately above the
eye sockets. All axis-scale directives, fitted/raw bounds and maximum fit
displacements are recorded in the provenance manifest. Head anatomy is unchanged.
The meshes remain unskinned: the runtime must supply
head-bone weights and bind to its existing skeleton.

Both accessories retain source UVs converted to glTF top-left as `[u,1-v]` in
`TEXCOORD_0`, exposed as Three `uv`. Use `flipY=false` on their alpha textures.
Placeholder GLB materials declare double-sided alpha masking and identify the
texture filenames in extras, but fetch no images. Runtime material/loading
integration assigns the actual textures and rendering settings.

The outputs are publicly hosted together under `/models/football/`:

- `review-skin-basecolor.webp`: the complete 2048px source atlas, encoded at
  quality 95 so the face keeps the original atlas resolution. Use the separate
  review head's `TEXCOORD_1` / `uv1`, texture `channel=1`, `flipY=false`.
- `review-hair.webp`: 1024px RGBA with lossless WebP encoding.
- `review-brows.webp`: 512px RGBA with lossless WebP encoding.

Alpha maps use Lanczos resizing when needed and preserve every resized RGBA pixel
through WebP encoding. The skin export records decoded RGB compression error.
The manifest records Pillow and libwebp versions, all output hashes, dimensions,
mesh counts/bounds and the processing-script hash.

Reproduce using Python with Pillow/WebP support and the downloader's extracted
selected assets plus `selected-assets-manifest.json`:

```sh
python3 scripts/assets/build-football-review-player.py \
  --sources /path/to/core-assets --base /path/to/pinned/base.obj
python3 scripts/assets/build-football-review-player.py \
  --sources /path/to/core-assets --base /path/to/pinned/base.obj --check
```

The standalone check verifies pack/source/license identities, reparses GLB buffer
and accessor bounds, checks finite unit normals, and compares every indexed
triangle corner directly with its MHCLO fitted position and source OBJ UV. It
also rejects the former floating accessory bounds. It verifies alpha
pixel fidelity and regenerates/byte-compares every output and the manifest.
Existing head assets and their manifests remain unchanged.

`short01` includes elevated hair cards roughly 1.93cm above the fitted neutral
skull. This package adds no dynamic hair simulation, collision fitting or brow-expression rig.
Rendered quality, runtime memory/performance and physical-device acceptance are
separate evidence from these structural and texture checks.
