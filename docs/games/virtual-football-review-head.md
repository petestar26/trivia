# Review head source UV adapter

`review-head-high.glb` is a separate high-detail review asset derived from the
pinned `player-head-high.glb` and the pinned MakeHuman CC0 core `base.obj`.
The original high/mid/low heads and their provenance remain unchanged.

The original eight relative position morphs, all eight normal morphs, neutral
positions, normals, semantic parts, iris detail, colors and existing UVs remain
exactly equal at every indexed triangle corner. The adapter duplicates vertices
at source OBJ UV seams; it does not reshape or simplify anatomy. Triangle order,
neutral morph weights and target names/order remain unchanged.

`TEXCOORD_0` retains the shipped authored UVs. `TEXCOORD_1` supplies the core OBJ
skin UVs converted from OBJ bottom-left to glTF top-left as `[u, 1-v]`. Three.js
exposes the latter as `uv1`; a skin texture using it needs `channel = 1` and
`flipY = false`. Added fitted eye caps, irises, pupils and brows have `[0,0]`
on this new UV channel and retain their original attributes. Runtime material
selection must keep those attachments on their own semantic shading.

The asset remains unskinned, matching its input. Runtime preparation must retain
both UV channels, every morph attribute and semantic attribute when trimming
clavicles, then apply the existing normalized head/neck weights and binding.
This adapter does not load assets or alter the running roster.

Reproduce with Python's standard library:

```sh
python3 scripts/assets/build-football-review-head.py /path/to/pinned/base.obj
python3 scripts/assets/build-football-review-head.py /path/to/pinned/base.obj --check
```

The standalone check verifies exact source, shipped input and retained CC0
license hashes; regenerates and byte-compares the review GLB and its separate
`review-head-provenance.json`; reparses all GLB/accessor bounds; and compares every
indexed output corner against the original neutral/morph values and original
OBJ UV corner. Source and output identities are recorded in that manifest.
The adapter imports no texture or third-party asset. License and texture
selection for a later material package require their own provenance.

These checks establish UV and geometry correspondence. Rendered facial quality,
runtime performance and physical-device acceptance require separate evidence.
