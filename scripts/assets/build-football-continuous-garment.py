"""Bind the pinned CC0 tucked shirt through its original MakeClothes triples.

No download, static-preview transform, nearest-vertex transfer or new rig is used.
The body binding must retain every original base vertex, its full normalized
49-joint weights and its native-to-production offset derivative. The runtime
uses the resulting geometry with the existing independent 49-joint skeleton.

python3 scripts/assets/build-football-continuous-garment.py \
  --packet /path/to/PlayQube_Football_Garment_Fit_Packet_20261020 \
  --body-binding /path/to/continuous-body-bind.json --output /path/to/output
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[2]
NAME = "toigo_basic_tucked_t-shirt"
BASE_SHA = "8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c"
OBJ_SHA = "22159cf14d1f6831f931b49625f8f7692910bac22499c43466c0b5a2159b4d03"
MHCLO_SHA = "c34bd03895c5ad9ec46965ef7d5f3e5e8c567630797ab312f8762c1d9fde8f71"
LICENSE_SHA = "f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def vector(value, count):
    require(len(value) == count and all(math.isfinite(float(x)) for x in value),
            f"Expected finite vector of length {count}")
    return [float(x) for x in value]


def read_obj(raw):
    positions, uvs, polygons = [], [], []
    for line in raw.decode().splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "v":
            positions.append(vector(fields[1:4], 3))
        elif fields[0] == "vt":
            uvs.append(vector(fields[1:3], 2))
        elif fields[0] == "f":
            corners = []
            for field in fields[1:]:
                ids = field.split("/")
                require(len(ids) >= 2 and ids[1], "Each OBJ corner must retain a UV")
                vertex, uv = int(ids[0]) - 1, int(ids[1]) - 1
                require(0 <= vertex < len(positions) and 0 <= uv < len(uvs), "OBJ corner out of range")
                corners.append([vertex, uv])
            require(len(corners) >= 3, "Invalid polygon")
            polygons.append(corners)
    require(positions and uvs and polygons, "Empty garment OBJ")
    return positions, uvs, polygons


def read_mhclo(raw, base, count):
    rows, scales, directives = [], {}, {}
    active, basemesh = False, None
    for line in raw.decode().splitlines():
        fields = line.split()
        if not fields or fields[0].startswith("#"):
            continue
        key = fields[0]
        require(key != "delete_verts", "Pinned preferred shirt has no delete_verts; inspect changed source before masking")
        require("shear" not in key, "Unsupported MHCLO shear directive")
        if key == "basemesh":
            basemesh = fields[1]
        if key in ("x_scale", "y_scale", "z_scale"):
            axis = "xyz".index(key[0])
            a, b, divisor = int(fields[1]), int(fields[2]), float(fields[3])
            require(0 <= a < len(base) and 0 <= b < len(base) and divisor > 0,
                    "Invalid scale references")
            scales[axis] = abs(base[a][axis] - base[b][axis]) / divisor
            directives[key] = {"baseVertexIds": [a, b], "denominator": divisor,
                               "ratio": scales[axis]}
        if key == "verts":
            require(fields[1:] == ["0"], "Expected zero-based complete MHCLO rows")
            active = True
            continue
        if active:
            if not key.lstrip("-").isdigit():
                active = False
                continue
            require(len(fields) == 9, "Pinned shirt requires triple correspondence and offset")
            ids = [int(x) for x in fields[:3]]
            coefficients = vector(fields[3:6], 3)
            offset = vector(fields[6:9], 3)
            require(all(0 <= i < len(base) for i in ids), "MHCLO reference out of range")
            require(abs(sum(coefficients) - 1) < .0001, "Invalid MHCLO coefficient sum")
            rows.append({"baseVertexIds": ids, "coefficients": coefficients, "offset": offset})
    require(basemesh == "hm08" and len(rows) == count, "MHCLO source identity/count mismatch")
    require(set(scales) == {0, 1, 2}, "Missing MHCLO axis scales")
    for row in rows:
        row["scaledOffset"] = [row["offset"][k] * scales[k] for k in range(3)]
    return rows, directives


def full_weights(raw):
    """Read full normalized weights without applying the body's max4 truncation."""
    if isinstance(raw, dict):
        result = {int(k): float(v) for k, v in raw.items()}
    elif len(raw) == 49 and all(isinstance(x, (float, int)) for x in raw):
        result = {i: float(w) for i, w in enumerate(raw) if w}
    else:
        result = {}
        for joint, weight in raw:
            joint = int(joint)
            result[joint] = result.get(joint, 0.) + float(weight)
    require(result and all(0 <= i < 49 and math.isfinite(w) and w >= 0 for i, w in result.items()),
            "Invalid full normalized49 source weights")
    require(abs(sum(result.values()) - 1) < 1e-6, "Body full49 source weights are not normalized")
    return result


def validate_binding(binding, base, joint_names):
    require(binding["sourceSHA256"] == BASE_SHA, "Binding is for another base source")
    require(binding["jointNames49"] == joint_names and len(joint_names) == 49,
            "Binding joint order differs from production49")
    count = len(base)
    for key in ("sourcePositions", "positions", "vertexTransforms", "normalized49Weights"):
        require(len(binding[key]) == count, f"Body binding loses original source IDs: {key}")
    for i, point in enumerate(base):
        require(max(abs(a - b) for a, b in zip(vector(binding["sourcePositions"][i], 3), point)) < 1e-8,
                "Binding native source positions differ from pinned base")
        vector(binding["positions"][i], 3)
        matrix = binding["vertexTransforms"][i]
        if len(matrix) == 3 and isinstance(matrix[0], list):
            matrix = [x for row in matrix for x in row]
        binding["vertexTransforms"][i] = vector(matrix, 9)
    return [full_weights(row) for row in binding["normalized49Weights"]]


def fit_and_transfer(binding, body_weights, rows):
    positions, normalized, capped, reports = [], [], [], []
    for row in rows:
        ids, coefficients, offset = row["baseVertexIds"], row["coefficients"], row["scaledOffset"]
        # Evaluate the body retarget at each exact correspondence reference;
        # transform the source offset by the same blended local derivatives.
        point = [sum(c * (binding["positions"][i][axis] +
                          sum(binding["vertexTransforms"][i][axis * 3 + k] * offset[k] for k in range(3)))
                     for i, c in zip(ids, coefficients)) for axis in range(3)]
        vector(point, 3)
        merged = {}
        for i, coefficient in zip(ids, coefficients):
            for joint, weight in body_weights[i].items():
                merged[joint] = merged.get(joint, 0.) + coefficient * weight
        negative = -sum(w for w in merged.values() if w < 0)
        positive = [(j, w) for j, w in merged.items() if w > 0]
        positive.sort(key=lambda pair: (-pair[1], pair[0]))
        total = sum(w for _, w in positive)
        require(total > 1e-12, "Unbound garment vertex after signed interpolation")
        positive = [(j, w / total) for j, w in positive]
        selected = positive[:4]
        retained = sum(w for _, w in selected)
        selected = [(j, w / retained) for j, w in selected]
        indices = [j for j, _ in selected] + [0] * (4 - len(selected))
        weights = [w for _, w in selected] + [0.] * (4 - len(selected))
        positions.append(point)
        normalized.append(positive)
        capped.append((indices, weights))
        reports.append({"negativeMergedMassClamped": negative, "mergedInfluences": len(positive),
                        "discardedNormalizedMass": 1 - retained,
                        "coefficientSumError": abs(sum(coefficients) - 1)})
    return positions, normalized, capped, reports


def export_geometry(points, uvs, polygons, capped):
    triangles = [[face[0], face[i], face[i + 1]] for face in polygons for i in range(1, len(face) - 1)]
    normals = [[0., 0., 0.] for _ in points]
    for triangle in triangles:
        a, b, c = [points[corner[0]] for corner in triangle]
        u, v = [[p[k] - a[k] for k in range(3)] for p in (b, c)]
        n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        require(sum(x * x for x in n) > 1e-24, "Degenerate retargeted garment triangle")
        for source, _ in triangle:
            normals[source] = [a + b for a, b in zip(normals[source], n)]
    for i, n in enumerate(normals):
        length = math.sqrt(sum(x * x for x in n))
        require(length > 1e-14, "Unreferenced or degenerate garment source vertex")
        normals[i] = [x / length for x in n]
    geometry = {"schemaVersion": 1, "coordinateSpace": "production world-rest metres",
                "positions": [], "normals": [], "uv": [], "skinIndices": [], "skinWeights": [], "indices": []}
    split_ids, split_uvs, lookup = [], [], {}
    for triangle in triangles:
        for source, uv in triangle:
            key = (source, uv)
            if key not in lookup:
                lookup[key] = len(split_ids)
                split_ids.append(source)
                split_uvs.append(uv)
                geometry["positions"].extend(points[source])
                geometry["normals"].extend(normals[source])
                # Same OBJ-to-glTF convention as the accepted accessory export.
                geometry["uv"].extend([uvs[uv][0], 1 - uvs[uv][1]])
                geometry["skinIndices"].extend(capped[source][0])
                geometry["skinWeights"].extend(capped[source][1])
            geometry["indices"].append(lookup[key])
    geometry["sourceVertexIds"] = split_ids
    geometry["sourceUvIds"] = split_uvs
    return geometry


def glb(geometry, contract):
    chunks, views, accessors, offset = [], [], [], 0
    def attribute(values, width, component=5126):
        nonlocal offset
        if offset % 4:
            padding = (-offset) % 4
            chunks.append(bytes(padding)); offset += padding
        formats = {5126: "f", 5123: "H", 5125: "I"}
        raw = struct.pack("<" + formats[component] * len(values), *values)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw)})
        chunks.append(raw); offset += len(raw)
        record = {"bufferView": len(views) - 1, "componentType": component,
                  "count": len(values) // width, "type": {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4", 16: "MAT4"}[width]}
        if width == 3:
            record.update(min=[min(values[k::3]) for k in range(3)], max=[max(values[k::3]) for k in range(3)])
        accessors.append(record)
        return len(accessors) - 1
    attributes = {"POSITION": attribute(geometry["positions"], 3), "NORMAL": attribute(geometry["normals"], 3),
                  "TEXCOORD_0": attribute(geometry["uv"], 2), "JOINTS_0": attribute(geometry["skinIndices"], 4, 5123),
                  "WEIGHTS_0": attribute(geometry["skinWeights"], 4)}
    indices = attribute(geometry["indices"], 1, 5125)
    rig = contract["rig"]
    names, bones = rig["boneOrder"], rig["bones"]
    inverse_binds, nodes = [], []
    for name in names:
        x, y, z = bones[name]["worldMetres"]
        inverse_binds.extend([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1])
        node = {"name": name, "translation": bones[name]["localMetres"]}
        children = [i for i, child in enumerate(names) if bones[child]["parent"] == name]
        if children:
            node["children"] = children
        nodes.append(node)
    ibm = attribute(inverse_binds, 16)
    nodes.append({"name": "continuous-jersey", "mesh": 0, "skin": 0})
    binary = b"".join(chunks)
    binary += bytes((-len(binary)) % 4)
    document = {"asset": {"version": "2.0", "generator": "PlayQube original-correspondence continuous shirt bind"},
                "scene": 0, "scenes": [{"nodes": [0, 49]}], "nodes": nodes,
                "skins": [{"name": "existing-production49", "joints": list(range(49)), "skeleton": 0, "inverseBindMatrices": ibm}],
                "meshes": [{"primitives": [{"attributes": attributes, "indices": indices, "material": 0}]}],
                "materials": [{"name": "Original Ruby Grand ruby cloth - reversible tint", "doubleSided": True,
                               "pbrMetallicRoughness": {"baseColorFactor": [.1946178304, .0185002201, .0466650863, 1],
                                                       "metallicFactor": 0, "roughnessFactor": .88}}],
                "buffers": [{"byteLength": len(binary)}], "bufferViews": views, "accessors": accessors,
                "extras": {"bindFrame": "Identity mesh world matrix; existing 49 production joints and inverse binds",
                           "sourceVertexMap": "continuous-jersey.mapping.json", "staticPreviewConversionUsed": False,
                           "scope": "Single-player prototype binding; posed fit and corrective acceptance remain separate"}}
    document_raw = json.dumps(document, separators=(",", ":"), allow_nan=False).encode()
    document_raw += b" " * ((-len(document_raw)) % 4)
    return (struct.pack("<III", 0x46546c67, 2, 28 + len(document_raw) + len(binary)) +
            struct.pack("<II", len(document_raw), 0x4e4f534a) + document_raw +
            struct.pack("<II", len(binary), 0x004e4942) + binary)


def encode_json(value):
    return (json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n").encode()


def build(packet, body_binding, output, contract_path):
    packet, output = Path(packet), Path(output)
    sources = json.loads((packet / "SOURCES.json").read_text())
    folder = packet / "sources/clothes" / NAME
    selected = {"obj": (folder / "t_shirt_basic_tucked.obj", OBJ_SHA),
                "mhclo": (folder / (NAME + ".mhclo"), MHCLO_SHA),
                "base": (packet / "sources/makehuman-core-base.obj", BASE_SHA),
                "license": (packet / "sources/MakeHuman-LICENSE.ASSETS.md", LICENSE_SHA)}
    raw, records = {}, {}
    for key, (path, expected) in selected.items():
        raw[key] = path.read_bytes()
        require(sha(raw[key]) == expected, f"Pinned {key} SHA mismatch")
        records[key] = {"packetPath": str(path.relative_to(packet)), "sha256": expected, "bytes": len(raw[key])}
    require(b"# license CC0" in raw["obj"] and b"# license CC0" in raw["mhclo"], "Missing retained garment CC0 headers")
    base = [vector(line.split()[1:4], 3) for line in raw["base"].decode().splitlines() if line.startswith("v ")]
    original, uvs, polygons = read_obj(raw["obj"])
    rows, directives = read_mhclo(raw["mhclo"], base, len(original))
    binding_raw = Path(body_binding).read_bytes()
    binding = json.loads(binding_raw)
    contract_raw = Path(contract_path).read_bytes()
    contract = json.loads(contract_raw)
    body_weights = validate_binding(binding, base, contract["rig"]["boneOrder"])
    points, normalized, capped, reports = fit_and_transfer(binding, body_weights, rows)
    geometry = export_geometry(points, uvs, polygons, capped)
    mapping = {"schemaVersion": 1, "originalSourceVertexIdsPreserved": True,
               "sourcePositions": original, "sourceUVs": uvs, "sourcePolygons": polygons,
               "mhcloRows": rows, "mhcloAxisScaleDirectives": directives, "bindPositions": points,
               "sourceBodyHideMask": {"directivePresent": False, "baseVertexIds": [],
                                      "semantics": "Original preferred MHCLO supplies no delete_verts. No body removal inferred by exporter."},
               "nativeFittedPositions": [[sum(base[i][k] * c for i, c in zip(row["baseVertexIds"], row["coefficients"])) + row["scaledOffset"][k]
                                           for k in range(3)] for row in rows],
               "normalized49Weights": normalized, "cappedSkinIndices": [entry[0] for entry in capped],
               "cappedSkinWeights": [entry[1] for entry in capped], "perVertexTransferAudit": reports,
               "splitSourceVertexIds": geometry["sourceVertexIds"], "splitSourceUvIds": geometry["sourceUvIds"],
               "jointNames49": binding["jointNames49"]}
    edges = Counter(tuple(sorted((face[i][0], face[(i + 1) % len(face)][0]))) for face in polygons for i in range(len(face)))
    provenance = {"schemaVersion": 1, "sourceName": NAME, "authors": sources["authors"][NAME],
                  "license": sources["license"], "sourceListing": sources["listing"], "archive": sources["archive"],
                  "pinnedSourceFiles": records, "baseSource": sources["base"],
                  "bodyBindingSHA256": sha(binding_raw), "productionContractSHA256": sha(contract_raw),
                  "exporterSHA256": sha(Path(__file__).read_bytes()),
                  "counts": {"sourceVertices": len(original), "mhcloTriples": len(rows), "sourceUVs": len(uvs),
                             "sourcePolygons": len(polygons), "exportVertices": len(geometry["sourceVertexIds"]),
                             "triangles": len(geometry["indices"]) // 3, "boundaryEdges": sum(n == 1 for n in edges.values()),
                             "nonManifoldEdges": sum(n > 2 for n in edges.values()), "productionJoints": 49,
                             "maxExportInfluences": max(sum(w > 0 for w in entry[1]) for entry in capped)},
                  "transfer": {"positionRecipe": "sum(coeff_i * (bodyBindPosition_i + bodyNativeToProductionDerivative_i * axisScaledMHCLOOffset))",
                               "weightRecipe": "sum(coeff_i * fullNormalized49BodyWeights_i), merge joint IDs, clamp negative merged influence, normalize, stable greatest4 cap, normalize",
                               "negativeCoefficientRows": sum(any(c < 0 for c in r["coefficients"]) for r in rows),
                               "negativeMergedMassRows": sum(r["negativeMergedMassClamped"] > 0 for r in reports),
                               "maxNegativeMergedMassClamped": max(r["negativeMergedMassClamped"] for r in reports),
                               "maxCoefficientSumError": max(r["coefficientSumError"] for r in reports),
                               "truncatedVertices": sum(r["mergedInfluences"] > 4 for r in reports),
                               "maxDiscardedNormalizedMass": max(r["discardedNormalizedMass"] for r in reports),
                               "meanDiscardedNormalizedMass": sum(r["discardedNormalizedMass"] for r in reports) / len(reports),
                               "maxExportWeightSumError": max(abs(sum(entry[1]) - 1) for entry in capped),
                               "unboundVertices": sum(sum(entry[1]) == 0 for entry in capped),
                               "uvConvention": "Original OBJ UV corners retained; glTF V=1-OBJ_V; smooth normals accumulated by original source vertex",
                               "staticPreviewConversionUsed": False},
                  "originalKitVariation": {"direction": "Ruby Grand", "rubySRGB": "#7a253d", "roseGoldSRGB": "#d7b08b",
                                           "materialOnlyReversible": True, "sourceTextureModified": False,
                                           "notes": "Original ruby cloth tint; retained original UVs enable separate original number/pattern work. No sponsor/brand marks introduced."},
                  "sourceBodyHideMask": mapping["sourceBodyHideMask"],
                  "scope": "Preferred CC0 short-sleeve shirt on same continuous body production49 prototype",
                  "unverified": ["Garment/body clipping under full action range", "shoulder/elbow pose correction", "collar/hem thickness and football tailoring", "physical-device performance"],
                  "missing": ["separate football shorts", "goalkeeper long-sleeve variant", "original boots and keeper gloves", "garment corrective shapes", "complete football motion package"]}
    output.mkdir(parents=True, exist_ok=True)
    outputs = {"continuous-jersey.geometry.json": encode_json(geometry), "continuous-jersey.mapping.json": encode_json(mapping),
               "continuous-jersey.glb": glb(geometry, contract)}
    provenance["outputs"] = {name: {"sha256": sha(value), "bytes": len(value)} for name, value in outputs.items()}
    outputs["continuous-jersey.provenance.json"] = encode_json(provenance)
    for name, data in outputs.items():
        (output / name).write_bytes(data)
    return provenance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--body-binding", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--contract", type=Path, default=ROOT / "docs/games/virtual-football-continuous-player-contract.json")
    args = parser.parse_args()
    result = build(args.packet, args.body_binding, args.output, args.contract)
    print(json.dumps({"counts": result["counts"], "transfer": result["transfer"], "outputs": result["outputs"]}, indent=2))


if __name__ == "__main__":
    main()
