"""Add pinned MakeHuman core UVs to a separate review head; Python stdlib only.

python3 scripts/assets/build-football-review-head.py path/to/pinned/base.obj [--check]
The existing shipped head GLBs and their manifest are read-only inputs.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "apps/web/public/models/football"
SOURCE_SHA = "8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c"
HEAD_SHA = "8afedf4d02b1fd60acbec56994b9ca29992ecf30538f67d2f31842b181a4ccfc"
LICENSE_SHA = "f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c"
COMMIT = "a8bc2d54ff0ac92e78ff71431b1023eda42bf482"
COMPONENTS = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
              5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
SIZES = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_glb(raw):
    require(len(raw) >= 28, "Truncated GLB")
    require(struct.unpack_from("<III", raw) == (0x46546C67, 2, len(raw)), "Invalid GLB header")
    length, kind = struct.unpack_from("<II", raw, 12)
    require(kind == 0x4E4F534A and length % 4 == 0, "Invalid GLB JSON chunk")
    document = json.loads(raw[20:20 + length])
    binary_length, kind = struct.unpack_from("<II", raw, 20 + length)
    binary = raw[28 + length:]
    require(kind == 0x004E4942 and binary_length == len(binary), "Invalid GLB binary chunk")
    require(len(document["buffers"]) == 1, "Expected one embedded buffer")
    require(document["buffers"][0]["byteLength"] <= len(binary), "Buffer exceeds GLB binary")
    for view in document["bufferViews"]:
        require(view["buffer"] == 0 and view.get("byteOffset", 0) % 4 == 0, "Unaligned buffer view")
        require(view.get("byteOffset", 0) + view["byteLength"] <= len(binary), "Buffer view out of bounds")
    for index in range(len(document["accessors"])):
        rows(document, binary, index)
    return document, binary


def rows(document, binary, index):
    accessor = document["accessors"][index]
    require("sparse" not in accessor, "Sparse accessors are unsupported")
    view = document["bufferViews"][accessor["bufferView"]]
    fmt, size = COMPONENTS[accessor["componentType"]]
    count = SIZES[accessor["type"]]
    width = count * size
    stride = view.get("byteStride", width)
    start = accessor.get("byteOffset", 0)
    require(stride >= width and start + max(0, accessor["count"] - 1) * stride + width <= view["byteLength"],
            "Accessor out of bounds")
    offset = view.get("byteOffset", 0) + start
    result = [struct.unpack_from("<" + fmt * count, binary, offset + i * stride)
              for i in range(accessor["count"])]
    require(all(math.isfinite(x) for row in result for x in row), "Nonfinite accessor")
    return result


def source_faces(raw):
    require(sha(raw) == SOURCE_SHA, "Expected individually pinned CC0 base.obj")
    vertices, uv, triangles = [], [], []
    group = ""
    for line in raw.decode().splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "v":
            vertices.append(tuple(map(float, fields[1:4])))
        elif fields[0] == "vt":
            uv.append(tuple(map(float, fields[1:3])))
        elif fields[0] == "g":
            group = fields[1]
        elif fields[0] == "f" and group == "body":
            corners = [tuple(int(value) - 1 for value in item.split("/")[:2]) for item in fields[1:]]
            if all(vertices[index][1] > 5.68 for index, _ in corners):
                for i in range(1, len(corners) - 1):
                    triangles.append((corners[0], corners[i], corners[i + 1]))
    used = sorted({index for triangle in triangles for index, _ in triangle})
    remap = {index: i for i, index in enumerate(used)}
    return vertices, uv, triangles, used, remap


def encode(document, binary):
    document["buffers"] = [{"byteLength": len(binary)}]
    binary += b"\0" * (-len(binary) % 4)
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary))
            + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def build(source_raw, head_raw):
    require(sha(head_raw) == HEAD_SHA, "Expected pinned shipped player-head-high.glb")
    vertices, source_uv, faces, used, remap = source_faces(source_raw)
    document, binary = read_glb(head_raw)
    mesh = document["meshes"][0]
    require(len(document["meshes"]) == len(mesh["primitives"]) == 1, "Expected one head primitive")
    primitive = mesh["primitives"][0]
    positions = rows(document, binary, primitive["attributes"]["POSITION"])
    original_indices = [row[0] for row in rows(document, binary, primitive["indices"])]
    require(len(used) == mesh["extras"]["sourceSurfaceVertices"] == 4367, "Source vertex count changed")
    require(len(faces) == mesh["extras"]["sourceTriangles"] == 8672, "Source triangle count changed")
    require(original_indices[:len(faces) * 3] == [remap[index] for face in faces for index, _ in face],
            "Shipped source triangle order differs from pinned OBJ")
    for i, source_index in enumerate(used):
        x, y, z = vertices[source_index]
        world = (x * .12, 1.5 + (y - 5.89) * .12, (z - .161) * .12)
        require(max(abs(a - b) for a, b in zip(positions[i], world)) < 2e-7,
                "Shipped anatomical source position mismatch")

    # A glTF vertex has one UV per attribute; retain a separate vertex for each
    # (original vertex, OBJ texture coordinate) pair at a genuine UV seam.
    vertex_map, originals, review_uv, indices = {}, [], [], []
    for corner_index, original in enumerate(original_indices):
        if corner_index < len(faces) * 3:
            source_index, uv_index = faces[corner_index // 3][corner_index % 3]
            require(remap[source_index] == original, "Source corner mismatch")
            u, v = source_uv[uv_index]
            texcoord = (u, 1 - v)  # glTF top-left convention; texture.flipY=false.
        else:
            uv_index, texcoord = -1, (0., 0.)
        key = (original, uv_index)
        if key not in vertex_map:
            vertex_map[key] = len(originals)
            originals.append(original)
            review_uv.append(texcoord)
        indices.append(vertex_map[key])
    core_count = len({(remap[index], uv_index) for face in faces for index, uv_index in face})
    require(max(indices) < 65536, "Review vertex count exceeds uint16 index budget")
    output = copy.deepcopy(document)
    output["accessors"], output["bufferViews"] = [], []
    blob = bytearray()

    def add(values, template):
        accessor = copy.deepcopy(template)
        accessor.pop("byteOffset", None)
        accessor.pop("sparse", None)
        accessor["count"] = len(values)
        fmt, _ = COMPONENTS[accessor["componentType"]]
        blob.extend(b"\0" * (-len(blob) % 4))
        offset = len(blob)
        blob.extend(struct.pack("<" + fmt * (len(values) * len(values[0])),
                                *(value for row in values for value in row)))
        output["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob) - offset})
        accessor["bufferView"] = len(output["bufferViews"]) - 1
        for bound, operation in [("min", min), ("max", max)]:
            if bound in accessor:
                accessor[bound] = [operation(row[k] for row in values) for k in range(len(values[0]))]
        output["accessors"].append(accessor)
        return len(output["accessors"]) - 1

    def duplicate(index):
        values = rows(document, binary, index)
        require(len(values) == len(positions), "Non-vertex accessor in head attributes")
        return add([values[original] for original in originals], document["accessors"][index])

    out_primitive = output["meshes"][0]["primitives"][0]
    out_primitive["attributes"] = {name: duplicate(index) for name, index in primitive["attributes"].items()}
    out_primitive["attributes"]["TEXCOORD_1"] = add(review_uv, {"componentType": 5126, "type": "VEC2"})
    out_primitive["targets"] = [{name: duplicate(index) for name, index in target.items()}
                                for target in primitive["targets"]]
    out_primitive["indices"] = add([(index,) for index in indices], {"componentType": 5123, "type": "SCALAR"})
    output["asset"]["generator"] = "Original PlayQube review head UV adapter v1"
    output["nodes"][0]["name"] = "Review anatomical player head high with source UV"
    output["meshes"][0]["name"] = "ReviewHead-high"
    extras = output["meshes"][0]["extras"]
    extras.update({"sourceSurfaceVertices": core_count, "originalSourceSurfaceVertices": len(used),
                   "reviewSourceHeadSHA256": HEAD_SHA,
                   "reviewUV": {"attribute": "TEXCOORD_1", "source": "Pinned core base.obj vt",
                                "transform": "[u, 1-v]", "textureFlipY": False,
                                "attachments": "[0,0]; use original UV/semantic shading for fitted eyes and brows"}})
    raw = encode(output, blob)
    report = validate(raw, head_raw, source_raw)
    report.update({"file": "review-head-high.glb", "sha256": sha(raw), "bytes": len(raw),
                   "sourceSurfaceVerticesAfterUVSplit": core_count,
                   "addedSeamVertices": len(originals) - len(positions)})
    return raw, report


def validate(output_raw, input_raw, source_raw):
    # Reparse encoded output and independently compare every indexed corner,
    # including all neutral attributes and every POSITION/NORMAL morph delta.
    out, out_bin = read_glb(output_raw)
    src, src_bin = read_glb(input_raw)
    _, source_uv, faces, _, _ = source_faces(source_raw)
    old = src["meshes"][0]["primitives"][0]
    new = out["meshes"][0]["primitives"][0]
    old_indices = [row[0] for row in rows(src, src_bin, old["indices"])]
    new_indices = [row[0] for row in rows(out, out_bin, new["indices"])]
    require(len(old_indices) == len(new_indices), "Triangle count changed")
    count = out["accessors"][new["attributes"]["POSITION"]]["count"]
    require(max(new_indices) < count and min(new_indices) >= 0 and len(new_indices) % 3 == 0,
            "Invalid output triangle indices")
    pairs = [(old["attributes"][name], new["attributes"][name]) for name in old["attributes"]]
    require(len(old["targets"]) == len(new["targets"]) == 8, "Expected eight morph targets")
    require(out["meshes"][0]["weights"] == src["meshes"][0]["weights"], "Neutral weights changed")
    require(out["meshes"][0]["extras"]["targetNames"] == src["meshes"][0]["extras"]["targetNames"],
            "Morph target names/order changed")
    for a, b in zip(old["targets"], new["targets"]):
        require(a.keys() == b.keys() == {"POSITION", "NORMAL"}, "Morph semantics changed")
        pairs.extend((a[name], b[name]) for name in a)
    for a, b in pairs:
        old_values, new_values = rows(src, src_bin, a), rows(out, out_bin, b)
        require(len(new_values) == count, "Attribute count mismatch")
        require(all(old_values[i] == new_values[j] for i, j in zip(old_indices, new_indices)),
                "Neutral attribute or morph delta changed at a triangle corner")
    uv = rows(out, out_bin, new["attributes"]["TEXCOORD_1"])
    require(len(uv) == count, "Review UV count mismatch")
    for corner, index in enumerate(new_indices):
        if corner < len(faces) * 3:
            _, uv_index = faces[corner // 3][corner % 3]
            u, v = source_uv[uv_index]
            expected = struct.unpack("<ff", struct.pack("<ff", u, 1 - v))
        else:
            expected = (0., 0.)
        require(uv[index] == expected, "Output UV differs from source OBJ corner")
    return {"vertices": count, "triangles": len(new_indices) // 3,
            "sourceUVTriangleCornersChecked": len(faces) * 3,
            "neutralAndMorphAccessorsCompared": len(pairs),
            "passes": ["GLB headers, aligned buffer views and accessor bounds",
                       "finite attributes and in-range triangle indices",
                       "all neutral triangle-corner attributes preserved exactly",
                       "all eight POSITION and NORMAL morph triangle-corner deltas preserved exactly",
                       "every anatomical triangle UV matches pinned OBJ with V converted to glTF",
                       "fitted attachments retain original attributes and blank source UV"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--check", action="store_true", help="Regenerate, validate and compare bytes without writing")
    parser.add_argument("--output", type=Path, default=ASSETS)
    args = parser.parse_args()
    source = args.source.read_bytes()
    original = (ASSETS / "player-head-high.glb").read_bytes()
    license_bytes = (ASSETS / "LICENSE-CC0.txt").read_bytes()
    require(sha(license_bytes) == LICENSE_SHA, "Retained CC0 license mismatch")
    raw, report = build(source, original)
    manifest = {
        "schemaVersion": 1, "exportVersion": "original-football-review-head-uv-v1",
        "authoringScriptSHA256": sha(Path(__file__).read_bytes()),
        "sources": [
            {"asset": "MakeHuman core base.obj", "commit": COMMIT, "sha256": SOURCE_SHA,
             "url": f"https://github.com/makehumancommunity/makehuman/blob/{COMMIT}/makehuman/data/3dobjs/base.obj",
             "license": "CC0-1.0", "retainedLicenseFile": "LICENSE-CC0.txt", "licenseSHA256": LICENSE_SHA},
            {"asset": "player-head-high.glb", "sha256": HEAD_SHA,
             "provenance": "player-head-provenance.json", "license": "CC0-1.0 source plus original authored attachments/morphs"}],
        "reproduce": "python3 scripts/assets/build-football-review-head.py path/to/pinned/base.obj --check",
        "uvContract": {"TEXCOORD_0": "Existing authored cylindrical/attachment UV retained exactly",
                       "TEXCOORD_1": "MakeHuman base.obj core UV [u,1-v]; Three uv1; texture.flipY=false",
                       "attachments": "Added fitted eyes, iris, pupils and brows use [0,0] on TEXCOORD_1"},
        "exports": [report], "runtimeDependencies": [], "textures": [],
        "limits": ["Review-only high detail alternative; shipped player head LODs remain unchanged.",
                   "No texture, hairstyle, material or runtime loader included in this UV adapter.",
                   "Source head remains unskinned; existing runtime trimming and normalized neck/head binding apply.",
                   "Structural correspondence is not rendered visual or physical-device acceptance."]}
    manifest_raw = (json.dumps(manifest, indent=2) + "\n").encode()
    output = args.output / "review-head-high.glb"
    manifest_path = args.output / "review-head-provenance.json"
    if args.check:
        require(output.read_bytes() == raw, "Review head export drift")
        require(manifest_path.read_bytes() == manifest_raw, "Review head manifest drift")
    else:
        args.output.mkdir(parents=True, exist_ok=True)
        output.write_bytes(raw)
        manifest_path.write_bytes(manifest_raw)
    print(json.dumps({"status": "PASS", "mode": "check" if args.check else "build", **report}, indent=2))


if __name__ == "__main__":
    main()
