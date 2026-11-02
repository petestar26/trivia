# Native V5 geometry renderer export

`deformation-authoring-source.json` is the exact immutable V5 source from the verified native evidence ZIP (SHA-256 `a789a7a9635f8bc20829e59557b2f1c37d3de8788be2facd3687202bc5e4bc32`). It contains original numerical tailoring, source weights, twelve pose guides, the complete new sock topology/UV/point attributes, 660 original plus 66 added sock vertex mappings, and 102 restored body triangles. It is not a human artist or finished realism claim.

From repository root, with `EVIDENCE` pointing to the unmodified extracted `PR59-4b07b6b28e36-native-player-evidence`:

```sh
python3 scripts/assets/build-football-native-player.py \
  --baseline "$EVIDENCE/verified-source/bridge/assembled-niko-bind.json"
```

The exporter pins both JSON identities and emits deterministic `apps/web/public/models/football/native-player-v5.glb` and its provenance JSON. The supplied baseline's source ID space is already UV split: body 10,212, authored jersey 1,794. These are not the 19,158 original MakeHuman IDs or the 163-bone authoring rig. Every emitted vertex has its exact source ID. New socks use the explicit source 660+66 mapping; low geometry records every original cluster member without averaging IDs. The asset has canonical49 rest/inverse binds, eight accepted facial channels, twelve new guide morphs, and exactly eight surfaces totalling 25,599 vertices and 34,007 triangles.

Neutral edits are applied once; V5's 122 front-ease rows are already merged into `neutralEdits`. Guide deltas convert native coordinates with inverse C `(x,z,-y)`. Area normals update the altered neutral/morph patches and their immediate neighbours, welding only equivalent smooth source corners. Eight existing facial position/normal channels are retained byte for byte; this export does not claim exact reproduction of Blender's custom-normal encoding.

The optional renderer mode `native-authored-v5` verifies the emitted SHA before parsing, then validates the unchanged canonical49 contract, all eight allowlisted surfaces, every source ID, index count and exact morph ownership. It adopts body, jersey, shorts and socks atomically. Current accepted face/hair/brows, fictional shirt-number shader and accepted generated boots retain their existing owners. Boot fitting and dynamic buffer upload run once through the existing code. Body, shirt and sock legacy CPU correctives and procedural garment fitting are bypassed in this mode; the twelve source morphs run on the GPU with independent semantic drivers. High/mid use full authored geometry; low retains reduced body/jersey geometry and all source morphs. Any optional native failure atomically loads the existing strict legacy continuous actor and its legacy motion.

The exporter never reads evaluated preview scene objects, root/leg animation, the hidden 65-bone rig, preview ground or the 241 boot-reference keys. It reads only the pinned source baseline, explicit authored JSON and unchanged raw body identity. Source inputs retain existing MakeHuman/MargaretToigo CC0 notices in `continuous-player-NOTICE.txt` and `review-player-source-notices.txt`; no new purchase or proprietary input is added. No API/shared/backend/flags/financial code changes belong to this export.

The 73.156 mm follow-through overlap remains open. Native structural results, actual browser visual evidence and physical-device acceptance are separate.
