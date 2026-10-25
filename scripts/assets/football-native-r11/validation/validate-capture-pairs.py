"""Check actual native capture provenance and matched transforms, not visual quality."""
import argparse
import hashlib
import json
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("directory", type=Path)
args = ap.parse_args()
root = args.directory
before = json.loads((root / "capture-ledger-before.json").read_text())
after = json.loads((root / "capture-ledger-after.json").read_text())
categories = (before["comparisonCategory"], after["comparisonCategory"])
combined = categories == (
    "original-native-geometry-and-current-baseline-motion",
    "new-native-geometry-and-supported-retarget",
)
assert combined or categories == ("motion-only-constant-geometry",) * 2
assert before["lighting"] == after["lighting"], "Lighting differs"
assert before["render"] == after["render"], "Render settings differ"
assert before["sourceControlsSha256"] == after["sourceControlsSha256"]
assert before["samplesPerCycle"] == after["samplesPerCycle"]
count = before["samplesPerCycle"]
assert len(before["frames"]) == len(after["frames"]) == 2 * count
if combined:
    assert before["sourceBlendSHA256"] != after["sourceBlendSHA256"]

def indexed(ledger):
    result = {}
    for item in ledger["frames"]:
        key = (item["phase"], item["view"])
        assert key not in result, key
        result[key] = item
        file = root / item["file"]
        assert hashlib.sha256(file.read_bytes()).hexdigest() == item["sha256"]
    return result

left, right = indexed(before), indexed(after)
assert left.keys() == right.keys()
max_error = 0.0
for key, old in left.items():
    new = right[key]
    for name in ("rootReferenceMetres", "cameraPosition", "cameraTarget", "cameraRotation"):
        error = max(abs(a - b) for a, b in zip(old[name], new[name]))
        max_error = max(error, max_error)
        assert error < 1e-6, (key, name, error)
    assert old["orthographicScale"] == new["orthographicScale"]
    assert old["nativeFrame"] == new["nativeFrame"]
    assert old["referenceSeconds"] == new["referenceSeconds"]
for frames in (left, right):
    for phase in sorted({k[0] for k in frames}):
        front, profile = frames[(phase, "front")], frames[(phase, "side")]
        assert front["cameraPosition"] != profile["cameraPosition"]
        assert front["cameraRotation"] != profile["cameraRotation"]
result = {
    "status": "PASS", "pairedFrames": len(left),
    "comparisonCategory": "combined-geometry-and-motion" if combined else categories[0],
    "maxMatchedTransformComponentError": max_error,
    "sourceHashes": {"before": before["sourceBlendSHA256"], "after": after["sourceBlendSHA256"]},
    "scope": "Matched source transforms/lighting and PNG byte hashes only; not visual acceptance, browser FPS or physical-device testing",
}
(root / "pair-validation.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
