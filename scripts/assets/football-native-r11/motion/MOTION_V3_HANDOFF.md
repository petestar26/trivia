# R11 motion V3 — anatomical hands and whole-arm fit

This supersedes the motion V2 candidate for final native capture; V2 and the a7d V4 combined evidence remain preserved. It is one editable native authoring candidate, with runtime adoption, general visual acceptance and roster expansion held.

## Frozen source

- Core `v3/Player_Jog.blend`: SHA-256 `c80d0910c4496324527de5adafc3199ea9a112a4fe5311c8e4139215a0cbd81d`.
- Normative semantic controls `v3/jog-controls.json`: SHA-256 `f5d4b6bb8911693eccd798d83fff2c0be5cdca3c74038f83902b0925736c8422`.
- The action identifiers remain `NIKO_JOG_SUPPORTED_V1` and `BASELINE_CURRENT_JOG_2p4`; the `V1` suffix is historical, not the fit version.

The source is the same free CC0 Quaternius Standard `Jog_Fwd_Loop` used in V2. Original archive SHA is `cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724`; selected non-root GLB SHA is `69591853d817488edaa8fd9bf8fc1d821eaeaf789f8627b3cd23b41c4ed67997`. The publisher listing dated June16 2026 calls the library v3.0; the archive itself has no separate internal semantic version. The retained CC0 license SHA is `6d01f55c6e4c49a2c9963e147e561945ae2c83958c8ca667d90a6bffdbfac061`. Per-clip authors are not specified; the publisher generally credits animator Gonzalo Furnier. No paid source archive was obtained. Raw source bytes are unchanged.

## Concrete repair

Source and target hand/index/middle/pinky rest positions define chirality-consistent dorsal palm normals. Each hand/finger anatomical frame uses its actual segment direction and projected palm normal, including the thumb. The source rest/world matrices and these calibrated target frames determine the retarget. Global-forward fallback is no longer used to choose hand/finger roll.

The compact upper-arm fit now applies the same world rotation to the entire upper-arm, forearm, wrist and finger subtree. The former upper-arm-only edit imposed a compensating relative elbow rotation. A source assertion measures local elbow quaternion preservation through the whole-subtree compact operation; maximum component difference is 2.98e-7.

Correct palm retargeting alone did not make the generic source fist relaxed. Its middle finger joint flex was roughly35–50 degrees and thumb terminal cross-plane spread approached38 degrees after the old fitting. This source limitation remains documented, rather than pretending an Euler-axis match solves it. V3 instead authors an explicit original anatomical relaxed hand study: individual MCP/PIP/DIP flex and small MCP spread, a 3% periodic tension curve, and thumb opposition36 degrees with flex20/18/10. The opposed thumb was selected after actual rendered left/right alternatives. It is original key-pose fitting, not a new professional football animator take or mocap.

`v3/hand-retarget-measurement.json` measures flex in each actual segment's perpendicular volar plane; comparing raw global Euler channels is not its acceptance criterion. The index PIP now spans20.37–21.63 degrees (mean21), versus the old source-fit34.71 degrees. Palm-plane geometry explains why forcing the accepted baseline's X Euler curl would be an unsafe shortcut: the resting target palms lie mainly in canonical Y/Z, so curl about a transverse axis can legitimately use Z.

All241 native samples of hips, spine, chest, neck, head, both upper/lower legs, feet and toes are exactly equal to V2. Pelvis position/quaternion, knee-pole directions and captured foot-error arrays also match exactly. No root, target, contact/reveal clock or ball fact moved. The source's a278 current-head equivalence proof remains `../validation/current-baseline-equivalence.json`: the retained bfd947a contact cache is bitwise JSON-equal to a fresh a27874c6 resample for this steady-state profile only.

## Rebuild and validate

Use Blender4.5.15 LTS, retaining `verified-source/` beside `motion/`:

```
Blender --background verified-source/native/PlayQube_ReviewPlayer_Baseline.blend --disable-autoexec --python-exit-code 1 --python motion/author-jog-v3.py -- --workdir motion/rebuilt-v3 --fit motion/jog-authoring-fit-v3.json --check
python3 motion/measure-hand-retarget.py
```

The source pins immutable baseline SHA `6a899f83bf3a8f26fa365ef1ad28acd074265fa0c5ea192ea502ea0f82a53e23` and retained241-sample contact SHA `6a015686e408c78dd5f99ef4b9635ee0fc8659fd52defd85bf35957e4fc21ab4`. The check saves and reopens a separate output, tests actual fractional FLOAT phase on both actions and linear preview-root extrapolation. The supplied source-check report passes. Root/current a278 contact cache SHA is `7886195dbad1c5d7346b73ab97f44a3453562122682421aef4a08966e64f2c08`; the differing cache header is not a numeric target change.

No schema authority changed. Native body action is in-place; its separate labelled preview root advances at2.4m/s. Runtime-facing quaternions/positions are absolute canonical-local targets, not deltas; interpolation is component Hermite plus normalization. A future adapter must freeze original RunPlant/ankle/fullfoot/toe constraints before applying visual pelvis/poles and live re-solve without replanning. Finger controls belong after existing target ownership and before temporal smoothing. The accepted interrupted arm-transition behavior must remain.

Geometry-owner V5 merges only after the bounded hand visual gate, retaining 49-joint rest/bind, accepted8face values and the same241 accepted CPU boot-reference keys/context guards. Final merged source hashes and independent structural checks are reported separately. This hand core does not alter meshes or material ownership.

## Evidence and limits

Final paired native full-cycle captures compare the unchanged fair BEFORE source f1a57f6 with the final V5/V3 merge. Both retain the same accepted boot adapter, FLOAT phase, root path, camera, light and capture-only ground. Native body capture uses48 phase samples per view; normal79.392encodedfps and slow19.848fps are playback rates, not browser/device FPS. Close-ups compare V2/V3 on one fixed selected geometry, with recorded per-hand tracking cameras; whole-body cameras track the identical preview root. Rejected V1/V2/initial-V3 trials and logs remain under `iterations/`.

Native baked leg interpolation remains approximate between dense keys. Because protected leg channels exactly match V2, the known native limitations remain: roughly0.7mm stance ankle and2.65mm swing-reference difference, up to0.92mm held-sole drift, while the accepted fitted boot mesh stays above ground. Final merged metrics must be tied to their exact source SHA; these numbers are not a claim of exact live authority. The approximately73.156mm follow-through overlap remains unchanged and open.

Hands now read less clawed in actual native renders, but geometry/skin folds are still stylized and carriage stays around upper abdomen. Hair, boots and cloth lack specialist console-style finishing. This is one supported reference-speed jog, not a completed acceleration/braking/turn/kick/keeper action or transition package. It has no actual-match adoption, runtime/device FPS, phone GPU/thermal/touch, live-server or general visual acceptance claim. No roster expansion, merge, deployment or activation.
