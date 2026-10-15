# Single Football review player

This continuation of PR59 keeps one home outfield actor (formation slot1, shirt2) on the new review surface. Every other roster member retains the PR59 asset/material/motion pipeline. The global facial-reset correction and phone layout are separate fixes. This character is for visual review; broader roster replacement waits for approval. No practice, admission, score, odds, server/reveal, receipt, balance, API, worker, shared-rule, migration or feature-flag behavior changes.

## Fitted assets and materials

The pinned MakeHuman core anatomical head now carries exact original UV corners, split at texture seams. Only this review player uses the individually verified CC0 core skin, short01 hair and eyebrow001 assets. Their source/version/license/CRC/SHA, fitted export hashes, texture dimensions and reproducible steps are in virtual-football-review-head.md, virtual-football-review-player.md and the two public provenance manifests. No application source, real-player scan, paid asset or console-game media is imported.

Raw accessory OBJs are authoring coordinates. The exporter evaluates each MHCLO neutral proxy barycentric triple and the axis-scaled offset against the pinned base mesh. This corrects the floating hair/brows caught by actual browser inspection. Hair/brow alpha is retained; alpha-tested double-sided card surfaces replace the close solid scalp cap and painted brow ribbons. The old scalp remains at distant detail. The 2048² skin diffuse retains pores, pigment and anatomical variation; runtime physical material controls eye clearcoat and skin/lip roughness separately. An original small sky/field reflection canvas supplies restrained ocular/hair reflections. This is an approximation, with no subsurface scattering, anisotropic strand shader or volumetric hair simulation.

The review head retains its textured anatomical neck. Its lower clavicle extraction is clipped, radially fitted into the garment, and blended down to the crew opening. Neutral and relative position/normal morphs follow that fit. The default roster head preparation remains unchanged. A short internal skin seal backs the garment join.

The derived body preserves source footwear, palm and finger positions/weights, softens shoulders/elbows/knees within2.5mm, subdivides selected joint edges and smooths duplicate shading normals. Separately skinned jersey/sleeve/short shells have original small folds and hem returns. A curved yoke joins the actual source jersey cut edges; a narrow chest/neck blend softens its inner crew edge. It is authored fitted geometry, without cloth simulation or a production garment pattern. Strong poses can still expose hard deformation or seam artifacts.

## Movement and state

Original bounded spine/chest/neck/free-arm posture offsets add drive, braking, counter-rotation, follow-through and landing/recovery to the existing authored poses. Root, pelvis, legs, phase and clocks are untouched. Keeper overlays re-solve the original wrist targets and restore wrist rotation; contribution is zero at the exact0.45s contact. The same existing final world support solver remains after review overlays. Finger cascade, thumb opposition and an open keeper posture alter only finger joints, preserving palms/wrists. Reduced motion keeps a fixed pose/expression.

Detail changes now reapply the latest facial input immediately after updateMorphTargets, including identity, expression suppression at low detail, restoration in both directions and reduced motion. There is no zero-morph rendered frame. New tests fail against the reviewed implementation before this fix.

The actual match uses the same character pipeline. The existing director still sees only released results. The review adapter does not add camera cuts, events, outcomes or a reveal schedule. The developer-only football-player-lab.html explicitly labels simulated diagnostics and supports scenario=idle/jog/acceleration/deceleration/plantedTurn/kick/keeperDive, keeper kit, face/profile and reduced motion. The moving turn follows a continuous approach/quarter-circle/exit with distance-driven gait and planted support; a stationary spin is not used as motion evidence.

## Detail and resource ownership

Only one actor receives the derived body and close head/hair/material. Low detail uses the original distant body/head/scalp, with review cloth/accessories hidden. The pool's original high-detail cap and hysteresis remain. Review high and mid head share the same anatomical source but have independent state wrappers; GPU morph-atlas residency remains a measured concern. Assets are optional and atomic: failed or malformed review assets retain the complete baseline player, successful siblings are released on rejection, and late resolution after disposal releases resources. Per-look wrappers/materials and the shared review asset set have separate idempotent cleanup.

Additional maps are one2048² skin diffuse, one1024² RGBA hair map and one512² RGBA brow map. RGBA8 with complete mip chains estimates28MiB for these three maps, before the reflection/PMREM, existing normal maps, bone/morph textures, geometry and driver costs. Files are compressed WebP for transfer; that does not establish GPU compression. GPU upload is deferred until close materials render. Encoded clip rate is playback speed, never runtime FPS. Actual full-roster software-browser timings, counters and cleanup observations are delivered separately; physical-phone GPU/thermal/touch acceptance remains pending.

## Phone and remaining acceptance

Secondary previous results and identity information follow the normal stage in DOM order. Portrait header/overview/fixture cards are compact, retaining the260px normal stage and horizontally reachable fixtures. Expanded portrait, single accessible reconnect status, mounted canvas/drafts, Return controls, Minimize/Escape and text/non-WebGL fallback remain intact.

This is a review candidate, not accepted console-quality realism. Skin retains baked diffuse information, eyes and expressions remain simple, hair is alpha cards, kit deformation is approximate, and some body/hand/keeper transitions still look mechanical. An artist-authored garment/deformation and animation pass, better neutral eye/skin calibration and physical-device profiling remain necessary. Do not infer broad roster approval or rollout from a close-up or test pass. Crash Point PG16, gateway full-path service-worker classification and retired production/PWA chunk recovery remain separate.
