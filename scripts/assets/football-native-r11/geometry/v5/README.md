# V5 front-panel ease derivative

This preserves V4 checkpoint `a7d496c22dea5775c5f53318e795a44884b3869fd0e4004060e53055636947fc` and its425 native checks. V4 source/helper copies are retained under `geometry/iterations/v4-a7d496c-checkpoint`.

`author-front-ease-v5.py` opens the V4 standalone deformation asset and adds an original source-tailoring patch to122 jersey vertices: up to5.5mm in source front +Z, symmetric at absX.075–.180m and sourceY1.12–1.30m, with smooth transition bands and every explicit cuff vertex excluded. The same offset is applied to every jersey shape key, so existing corrective deltas remain unchanged. Indices, UVs, all weights, body coverage, socks, accepted face, canonical49 rest/inverse and movement/contact/clocks remain unchanged. Only changed-front and immediate neighboring native custom normals request recomputation; old decoded normals are requested elsewhere. Re-encoding Blender custom normals measured a maximum0.000330151 vector difference outside that patch (about0.019degrees), explicitly bounded below0.0005; other meshes and shader routing remain unchanged. Existing `runtime_normal` remains a historical source reference.

Output source asset: `Player_Deformation.blend`, SHA-256 `11048754480e875596ab7482c20d58df53e0841f4ddd2f21cc17961b47ee6a80`. The derivative source JSON adds `frontPanelEaseV5` with the actual122 source offsets, normal selection, parent identities and support/control bounds, and merges the offsets into the full original-source reconstruction list.

`phase-one-third-pairs/` shows the exact offending V2 jog phase1/3 before/after with identical full49 FK hashes, cameras and lighting. The tan body triangle visible in `front-close-before-v4.png` is covered in `front-close-after-v5.png`. Six PNGs include full-front and profile views; the ledger records exact camera matrices/targets/rotations. The focused reopened-source suite passes61 checks. Recorded-camera rays through the tan patch reproduce the old cloth0.083–0.216mm behind the body and show the new cloth5.368–5.462mm ahead with identical body distances; this is local evidence, not a whole-garment collision proof. Reports/scripts and failed source-claim/harness assertions are retained in `validation/`. This is native source-only visual proof, not browser or device acceptance.

Rebuild order with Blender4.5.15 LTS, `--background --disable-autoexec --python-exit-code 1`:

1. Reproduce the documented V4 standalone deformation source.
2. Open `geometry/Player_Deformation.blend`; run `geometry/v5/author-front-ease-v5.py`.
3. Open the separately reviewed motion core; run `geometry/v5/merge-deformation-jog.py` to create a new V5 combined copy. Do not run that merge on an already combined file containing241 boot keys.
4. Independently reopen and validate against the V5 JSON and correct motion control file. Match rendered cameras/poses. Native binary save hashes are outputs, not a promise of byte-identical rebuild metadata.

Approved V3 motion core c80d0910c4496324527de5adafc3199ea9a112a4fe5311c8e4139215a0cbd81d is now merged into `Player_Combined.blend`, SHA-256196402fdca7bd447459412333698100e3ed36c7a59a73a0ff0d8aee04e6e76da (41,316,859bytes). Final source validation and actual visual acceptance remain separate. No runtime adoption is implied. Full cloth realism, specialist anatomy/materials and the73.156mm follow-through overlap remain open; roster expansion and visual acceptance stay held.
