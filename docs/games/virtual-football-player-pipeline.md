# Football player pipeline and review boundary

This Football-only follow-up to reviewed PR58 uses a locally hosted anatomical surface, original fitted facial features, original procedural materials and explicitly authored animation. It improves the actual running match roster; a concept image is not used as a runtime texture or performance result. No concept image was present in the accessible attachments, so implementation follows the written Ruby Grand/PlayQube art direction.

## Surfaces and original identities

The existing19 contact joints keep their rest positions and tested sole, kick and keeper constraints. Thirty articulated finger joints extend the rig to49. The locally packed, individually pinned CC0 Mesh2Motion human is retargeted into that rig. Original plane-split material boundaries, compressed clavicles, flexible neck, crew yoke and curved boot profile replace problematic seams. The toe profile follows the existing heel/forefoot roll datum; it does not change the motion clock or support solver.

The separately pinned MakeHuman core head supplies anatomical facial topology. Locally authored fitted eyes, hard2mm pupils, original iris fibres, brows and eight expression/identity morphs add ocular and facial detail. The runtime clips the source's clavicle extraction once, preserving/interpolating all neutral and relative morph attributes. Skin, lips, sockets, sclera, iris, pupils and brows use semantic material IDs. Original skin pore/roughness and fabric weave maps are generated deterministically, with no photographed skin or copied game texture.

Original fictional names and bounded facial/skin/eye/hair variations depend on display club IDs and slots. They do not inspect score, odds or future events. Three restrained scalp/strand styles and their three detail levels use shared geometry and reference-counted hair materials. Kits retain the original fictional club colors and receive original PlayQube shield badges, seams and stitching. Close players receive shared boot sole/stud/lace overlays. These are painted kit surfaces and authored overlays, not simulated garments.

## Animation and authority

Fourteen original native Three clips and intentional control curves cover run, acceleration, planted turn, idle, kick, keeper ready/dive/landing/recovery, celebration and dejection. The contact adapter applies the existing world sole, ball and hand constraints after posture blending. Gesture controls drive fingers without changing palm/wrist targets. Facial blinking and restrained expressions decorate moving players; reduced-motion actors have still expressions and the still fitted pitch/goalmouth camera remains intact.

Only already released match facts reach the director. This pipeline never chooses scores, alters the released-event schedule or predicts results. APIs/workers/shared rules, admission, practice rules, odds, payouts, balances, receipts, migrations, flags and financial activation are outside this change. Optional player review close-ups are a development lab, not a new result-reveal or production camera feature.

## Detail, ownership and budgets

Body exports contain14,102/6,000/2,800 triangles at high/mid/low. Head exports contain9,984/3,736/750 triangles before the runtime under-jaw cut. Each player owns its skeleton, identity color/UV wrappers and expression weights; neutral body/head buffers, CPU morph arrays, hairstyle geometry and maps are shared. Three r180 caches GPU morph atlases by geometry; independent identity wrappers can allocate separate atlases. Their texture counts and remaining memory cost must be assessed separately rather than claiming every GPU morph resource is shared. The pool caps high detail at two projected players, with threshold hysteresis and incumbent preference. Its camera selection depends on visible size, not events or results. Distant players retain hair rather than becoming bald.

The two shared512-square normal/roughness map pairs use approximately5.33MiB of RGBA GPU storage including a complete mip chain, before kit/stadium maps. This is an estimate from dimensions/format; actual renderer texture/geometry counts and wallclock observations belong in the delivery evidence. Loaded legacy and upgraded asset sets release all owned geometry/material/texture/skin resources on rejection, late completion, replacement and disposal. Three restored asynchronous lifecycle tests remain covered.

Installed Three.js is0.180.0. Its GLTFLoader supports Draco, KTX2 and Meshopt through configured decoders; those are not silently available just because the setter methods exist. No compression extension or decoder is added. Raw local GLBs keep the existing loader/fallback path and separately documented download/parse costs. The first upgrade fetches all three levels; cold-load memory/network cost remains a device-review consideration.

## Reproduction and evidence

Source/version/license/SHA-256 and exact authoring/export steps are recorded in:

- virtual-football-head-authoring.md and player-head-provenance.json;
- virtual-football-body-authoring.md and player-body-provenance.json;
- virtual-football-motion-authoring.md and the editable authored-motion source/bundle.

Run the standard development server and open `/football-player-lab.html` for the genuine high-detail player review view (`?face=1`, `?face=1&profile=1`, `?club=2&slot=2` or `?reduced=1`). Its exposed deterministic draw function is for local evidence capture. The existing `/football-lab.html?scene=match` uses the actual match engine. Neither HTML lab is part of the production index build.

Focused tests cover native clips, actual weighted fingers, independent expressions/rigs, contact/projection/reveal invariants, asset rejection/disposal and detail limits. A production contact-solved run sweep samples240 speed/phase cases per body level; the final sampled stance penetration is below0.9mm, versus34.84mm before the boot correction. Runtime tests also inspect the close-up sole overlays. These probes are bounded evidence, not full collision physics or a proof of every scale/transition.

Expanded portrait uses a compact4:3 pitch and already released match facts. A single persistent polite reconnect region sits inside the expanded arena. Canvas, drafts and Escape/Minimize behavior are retained. No extra live scoreboard is added.

## Remaining quality and acceptance limits

This is a reproducible authored-player foundation, not accepted console photorealism. Skin remains procedural; hair is a scalp cap with short geometric fibres; brows can read as painted; eye/skin shading lacks a dedicated film-quality surface package. The body retains a19-joint contact torso, painted kit regions and simple shoulder/cloth deformation. There is no motion capture, cloth/hair simulation, dental/tongue rig, full facial action system, collision anatomy or scanned real-person identity. Some pivots, reach limits and blends still look mechanical. The sampled shoe-contact sweep does not validate every running/landing/kicking transition.

No Blender/MPFB authoring application or licensed photorealistic skin/hair/garment package was available in this workspace. Original Python/Three authoring makes this pipeline reviewable, but does not substitute for an artist-authored production character/material/animation pass. Further realism work and independent visual acceptance remain required.

Evidence distinguishes exact matched-time engine/character captures from naturally advancing local page QA, encoded24fps playback from elapsed-wallclock software-renderer observations, and browser viewport emulation from physical/live acceptance. Physical iPhone/Safari/Android GPU, thermal, touch, rotation and live-server acceptance remain pending. Injected local imports/assets/WebGL failures establish containment; retired production/PWA chunk recovery remains separate. The inherited Crash Point PG16 CI failure and gateway full-path cache-header defect are unchanged and not repaired by these visual checks.
