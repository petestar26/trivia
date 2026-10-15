"""Process only selected, pinned CC0 MakeHuman core review-player assets.

Requires Pillow with WebP support. No network, AI generation or asset purchase.
python3 scripts/assets/build-football-review-player.py --sources /path/to/core-assets \
  --base /path/to/pinned/base.obj [--check]
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import struct
import zlib

import PIL
from PIL import Image, ImageChops, ImageStat, features

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "apps/web/public/models/football"
ARCHIVE_URL = "https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip"
LISTING_URL = "https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html"
ETAG = '"10bbb7ea-6160e7c0d7996"'
BASE_SHA = "8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c"
LICENSE_SHA = "f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c"
DIRECTORY_SHA = "95e78ccc765d5e77d270e0ca357317f543027143edff7f6435d2b8ed59a9d235"
PINNED = {
    "skins/young_caucasian_male/young_lightskinned_male_diffuse.png": "e723c591",
    "skins/young_caucasian_male/young_caucasian_male.mhmat": "dc98b0ac",
    "hair/short01/short01.obj": "05e068c9",
    "hair/short01/short01.mhmat": "583235b1",
    "hair/short01/short01.mhclo": "7b56f0f1",
    "hair/short01/short01_diffuse.png": "8a56cb2e",
    "eyebrows/eyebrow001/eyebrow001.obj": "07e9d5f6",
    "eyebrows/eyebrow001/eyebrow001.mhmat": "63d073c4",
    "eyebrows/eyebrow001/eyebrow001.mhclo": "593a400e",
    "eyebrows/eyebrow001/eyebrow001.png": "d5ee806a",
}
PINNED_SHA = {
    "skins/young_caucasian_male/young_lightskinned_male_diffuse.png": "862a26e335e958b70534cb5f0d7c47ef30ab148a56c42b3e9da969cf76f12963",
    "skins/young_caucasian_male/young_caucasian_male.mhmat": "6eda60b07ff2afbde078a2535ef3913593d84e9de92b2eb76c30f396a181fe2e",
    "hair/short01/short01.mhclo": "ae1ffaa98da5753b803b3a173bede4895d2215e6bb94763f3765a71f0e984f35",
    "hair/short01/short01.mhmat": "01e2e12ce3f3d3c859225456660acadcdd27d4f4b4d888bcbd6f11998cadd975",
    "hair/short01/short01.obj": "d998d8416f9b5d5591f1d756f4d292288d000a6951bc0f4d2e8e72727bbc44fa",
    "hair/short01/short01_diffuse.png": "f34a0957184e3d1e911ed59245f874f8d4843f61ee44ff49f43edb4be0196949",
    "eyebrows/eyebrow001/eyebrow001.obj": "88b13146395133f3901715e11706cdfd293e5d6087ad7c5e01efe1485a26b513",
    "eyebrows/eyebrow001/eyebrow001.png": "9940f7d0b1b223709a19b05156ba6f6e9e4dbdbced02d7574f4d51d72c58967b",
    "eyebrows/eyebrow001/eyebrow001.mhclo": "54c8892c2ba577f4152d779ce1f20f7cd323beb8cbd9cb701796165c221b4f5b",
    "eyebrows/eyebrow001/eyebrow001.mhmat": "976e5f4f1d3922d7a11c6e2db233f8b4584b068d00619d5749687e81c92d61fc",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def world(p):
    x, y, z = p
    return (x * .12, 1.5 + (y - 5.89) * .12, (z - .161) * .12)


def bounds(points):
    return {"min": [min(p[k] for p in points) for k in range(3)],
            "max": [max(p[k] for p in points) for k in range(3)]}


def f32(values):
    return struct.unpack("<" + "f" * len(values), struct.pack("<" + "f" * len(values), *values))


def fit_proxy(raw, base, count):
    """Evaluate the documented MHCLO neutral fit, not authoring OBJ coordinates.

    The format stores zero-based base-vertex triples, their barycentric weights,
    and an offset transformed by a diagonal scale matrix. Per-axis scale is the
    current base-vertex separation divided by the directive's denominator.
    """
    scales, assignments, directives = {}, [], {}
    in_vertices = False
    basemesh = None
    for line in raw.decode().splitlines():
        fields = line.split()
        if not fields or fields[0].startswith("#"):
            continue
        key = fields[0]
        if key == "basemesh":
            basemesh = fields[1]
        if key in ["x_scale", "y_scale", "z_scale"]:
            axis = "xyz".index(key[0])
            a, b, denominator = int(fields[1]), int(fields[2]), float(fields[3])
            require(0 <= a < len(base) and 0 <= b < len(base) and denominator > 0,
                    "Invalid MHCLO scale directive")
            scales[axis] = abs(base[a][axis] - base[b][axis]) / denominator
            directives[key] = {"baseVertices": [a, b], "denominator": denominator, "ratio": scales[axis]}
        if "shear" in key:
            raise ValueError("Unsupported MHCLO shear directive")
        if key == "z_depth":
            directives[key] = int(fields[1])
        if key == "verts":
            require(fields[1:] == ["0"], "Expected MHCLO vertex assignments starting at zero")
            in_vertices = True
            continue
        if in_vertices:
            if not key.lstrip("-").isdigit():
                in_vertices = False
                continue
            require(len(fields) in [1, 6, 9], "Invalid MHCLO vertex assignment")
            if len(fields) == 1:
                assignments.append(((int(fields[0]),), (1.,), (0., 0., 0.)))
            else:
                assignments.append((tuple(map(int, fields[:3])), tuple(map(float, fields[3:6])),
                                    tuple(map(float, fields[6:9])) if len(fields) == 9 else (0., 0., 0.)))
    require(basemesh == "hm08" and len(assignments) == count, "MHCLO base/vertex correspondence changed")
    require(set(scales) == {0, 1, 2}, "Expected all three MHCLO scale directives")
    fitted = []
    for references, weights, offset in assignments:
        require(all(0 <= index < len(base) for index in references), "MHCLO base reference out of range")
        require(abs(sum(weights) - 1) < .0001, "MHCLO barycentric weights do not sum to one")
        require(all(math.isfinite(value) for value in (*weights, *offset)), "Nonfinite MHCLO assignment")
        fitted.append(tuple(sum(base[index][axis] * weight for index, weight in zip(references, weights))
                            + scales[axis] * offset[axis] for axis in range(3)))
    return fitted, {"basemesh": basemesh, "vertexAssignments": len(assignments),
                    "assignmentRows": {"single": sum(len(row[0]) == 1 for row in assignments),
                                       "barycentricTriple": sum(len(row[0]) == 3 for row in assignments)},
                    "directives": directives,
                    "recipe": "sum(base[reference_i]*weight_i) + diagonal(axisScale)*offset; then world transform",
                    "offsetScaleRecipe": "axisScale=abs(base[a][axis]-base[b][axis])/directiveDenominator",
                    "indexConvention": "MHCLO base references are zero-based; OBJ face references are one-based",
                    "zDepthMeaning": "Render-order/masking metadata only; not an XYZ position offset",
                    "formatReference": "https://static.makehumancommunity.org/oldsite/documentation/file_formats_and_extensions.html"}


def read_obj(raw, proxy_raw, base):
    vertices, uv, source_normals, triangles = [], [], [], []
    polygons = Counter()
    for line in raw.decode().splitlines():
        fields = line.split()
        if not fields or fields[0].startswith("#"):
            continue
        if fields[0] == "v":
            vertices.append(tuple(map(float, fields[1:4])))
        elif fields[0] == "vt":
            uv.append(tuple(map(float, fields[1:3])))
        elif fields[0] == "vn":
            source_normals.append(tuple(map(float, fields[1:4])))
        elif fields[0] == "f":
            corners = []
            for field in fields[1:]:
                values = field.split("/")
                require(len(values) >= 2 and values[1], "Expected source OBJ UV at each corner")
                index, texcoord = int(values[0]) - 1, int(values[1]) - 1
                normal = int(values[2]) - 1 if len(values) > 2 and values[2] else None
                require(0 <= index < len(vertices) and 0 <= texcoord < len(uv), "Invalid OBJ index")
                require(normal is None or 0 <= normal < len(source_normals), "Invalid OBJ normal index")
                corners.append((index, texcoord, normal))
            polygons[len(corners)] += 1
            for i in range(1, len(corners) - 1):
                triangles.append((corners[0], corners[i], corners[i + 1]))
    require(vertices and uv and triangles, "Empty source OBJ")
    fitted, fitting = fit_proxy(proxy_raw, base, len(vertices))
    positions = [world(p) for p in fitted]
    raw_positions = [world(p) for p in vertices]
    fitting.update({"authoringOBJWorldBounds": bounds(raw_positions), "fittedWorldBounds": bounds(positions),
                    "maxAuthoringToFittedDisplacementMetres": max(math.dist(a, b) for a, b in zip(raw_positions, positions))})
    # Area-weighted smoothing by source position index keeps UV seams smooth.
    # Individual source hair cards remain disconnected as authored in the OBJ.
    accumulated = [[0., 0., 0.] for _ in vertices]
    for triangle in triangles:
        a, b, c = [positions[corner[0]] for corner in triangle]
        u, v = [b[k] - a[k] for k in range(3)], [c[k] - a[k] for k in range(3)]
        normal = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        for index, _, _ in triangle:
            for k in range(3):
                accumulated[index][k] += normal[k]
    normals = []
    for normal in accumulated:
        length = math.sqrt(sum(x * x for x in normal))
        require(length > 1e-14, "Degenerate/unreferenced source normal")
        normals.append(tuple(value / length for value in normal))
    output_positions, output_uv, output_normals, indices, mapping = [], [], [], [], {}
    for triangle in triangles:
        for corner in triangle:
            if corner not in mapping:
                index, texcoord, normal = corner
                mapping[corner] = len(output_positions)
                output_positions.append(positions[index])
                u, v = uv[texcoord]
                output_uv.append((u, 1 - v))
                n = source_normals[normal] if normal is not None else normals[index]
                length = math.sqrt(sum(x * x for x in n))
                require(length > 1e-14, "Invalid source normal")
                output_normals.append(tuple(x / length for x in n))
            indices.append(mapping[corner])
    return {"position": output_positions, "normal": output_normals, "uv": output_uv, "index": indices,
            "sourceVertices": len(vertices), "sourceTextureCoordinates": len(uv),
            "sourcePolygonSizes": dict(sorted(polygons.items())), "sourcePositions": positions,
            "sourceTriangles": triangles, "sourceUV": uv, "fitting": fitting}


def build_glb(hair, brows):
    binary, views, accessors = bytearray(), [], []

    def attr(values, kind, component=5126, with_bounds=False):
        binary.extend(b"\0" * (-len(binary) % 4))
        offset = len(binary)
        fmt = "f" if component == 5126 else "H"
        binary.extend(struct.pack("<" + fmt * sum(len(row) for row in values),
                                  *(value for row in values for value in row)))
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(binary) - offset})
        accessor = {"bufferView": len(views) - 1, "componentType": component, "type": kind, "count": len(values)}
        if with_bounds:
            accessor.update(bounds(values))
        accessors.append(accessor)
        return len(accessors) - 1

    meshes, reports = [], []
    for material, (name, source_name, texture, geometry) in enumerate([
        ("review-hair", "hair/short01/short01.obj", "review-hair.webp", hair),
        ("review-brows", "eyebrows/eyebrow001/eyebrow001.obj", "review-brows.webp", brows),
    ]):
        require(len(geometry["position"]) < 65536, "uint16 index budget exceeded")
        primitive = {"attributes": {"POSITION": attr(geometry["position"], "VEC3", with_bounds=True),
                                    "NORMAL": attr(geometry["normal"], "VEC3"),
                                    "TEXCOORD_0": attr(geometry["uv"], "VEC2")},
                     "indices": attr([(i,) for i in geometry["index"]], "SCALAR", 5123), "material": material}
        meshes.append({"name": name, "primitives": [primitive],
                       "extras": {"sourceAsset": source_name, "textureFile": texture,
                                  "neutralFittingAsset": source_name.replace(".obj", ".mhclo"),
                                  "neutralFittingRecipe": "Base-vertex barycentric position plus axis-scaled offset; then world transform",
                                  "binding": "Unskinned MHCLO-fitted world-rest vertices; runtime binds all vertices to existing head bone"}})
        reports.append({"mesh": name, "sourceAsset": source_name, "sourceVertices": geometry["sourceVertices"],
                        "sourceTextureCoordinates": geometry["sourceTextureCoordinates"],
                        "sourcePolygonSizes": geometry["sourcePolygonSizes"], "vertices": len(geometry["position"]),
                        "triangles": len(geometry["index"]) // 3, "worldBounds": bounds(geometry["position"]),
                        "neutralFitting": geometry["fitting"],
                        "normals": "Source normals when present; otherwise area-weighted by source position index before UV splitting"})
    document = {"asset": {"version": "2.0", "generator": "Original PlayQube selected CC0 core accessory adapter v2 MHCLO neutral fit",
                           "extras": {"coreAssetLicense": "CC0-1.0", "archiveETag": ETAG}},
                "scene": 0, "scenes": [{"nodes": [0, 1]}],
                "nodes": [{"name": name, "mesh": i} for i, name in enumerate(["review-hair", "review-brows"])],
                "meshes": meshes,
                "materials": [{"name": name, "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                                                                         "metallicFactor": 0, "roughnessFactor": .75},
                               "doubleSided": True, "alphaMode": "MASK", "alphaCutoff": .35,
                               "extras": {"runtimeBaseColorTexture": texture}}
                              for name, texture in [("review-hair", "review-hair.webp"), ("review-brows", "review-brows.webp")]],
                "buffers": [{"byteLength": len(binary)}], "bufferViews": views, "accessors": accessors}
    binary.extend(b"\0" * (-len(binary) % 4))
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    raw = (struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary))
           + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
           + struct.pack("<II", len(binary), 0x004E4942) + binary)
    validate_glb(raw, [hair, brows])
    return raw, reports


def validate_glb(raw, geometries):
    require(struct.unpack_from("<III", raw) == (0x46546C67, 2, len(raw)), "Invalid GLB header")
    size, kind = struct.unpack_from("<II", raw, 12)
    require(kind == 0x4E4F534A and size % 4 == 0, "Invalid JSON chunk")
    document = json.loads(raw[20:20 + size])
    size_bin, kind_bin = struct.unpack_from("<II", raw, 20 + size)
    binary = raw[28 + size:]
    require(kind_bin == 0x004E4942 and size_bin == len(binary), "Invalid binary chunk")
    for view in document["bufferViews"]:
        require(view["buffer"] == 0 and view["byteOffset"] % 4 == 0, "Invalid/aligned buffer view")
        require(view["byteOffset"] + view["byteLength"] <= len(binary), "Buffer view out of bounds")

    def rows(index):
        accessor = document["accessors"][index]
        view = document["bufferViews"][accessor["bufferView"]]
        count = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[accessor["type"]]
        fmt, width = ("f", 4) if accessor["componentType"] == 5126 else ("H", 2)
        require(accessor["count"] * count * width == view["byteLength"], "Accessor out of bounds")
        values = struct.unpack_from("<" + fmt * (accessor["count"] * count), binary, view["byteOffset"])
        require(all(math.isfinite(x) for x in values), "Nonfinite accessor")
        return [tuple(values[i:i + count]) for i in range(0, len(values), count)]

    require([node["name"] for node in document["nodes"]] == ["review-hair", "review-brows"], "Mesh contract changed")
    for mesh, geometry in zip(document["meshes"], geometries):
        primitive = mesh["primitives"][0]
        position, normal, uv = [rows(primitive["attributes"][key]) for key in ["POSITION", "NORMAL", "TEXCOORD_0"]]
        indices = [row[0] for row in rows(primitive["indices"])]
        require(len(position) == len(normal) == len(uv), "Attribute count mismatch")
        require(len(indices) % 3 == 0 and min(indices) >= 0 and max(indices) < len(position), "Invalid index")
        require(all(.9999 < math.sqrt(sum(x * x for x in n)) < 1.0001 for n in normal), "Nonunit normal")
        # Compare encoded corners directly with source OBJ position/UV corners,
        # independently of the seam-duplicate map used by the exporter.
        source_corners = [corner for triangle in geometry["sourceTriangles"] for corner in triangle]
        require(len(indices) == len(source_corners), "Source topology changed")
        for index, (source, texcoord, _) in zip(indices, source_corners):
            require(position[index] == f32(geometry["sourcePositions"][source]), "MHCLO fitted position changed")
            u, v = geometry["sourceUV"][texcoord]
            require(uv[index] == f32((u, 1 - v)), "Source UV changed")


def texture(raw, file, size, alpha):
    source = Image.open(BytesIO(raw))
    source.load()
    source_size, source_mode = source.size, source.mode
    require(source.width == source.height, "Expected square core texture")
    if alpha:
        require("A" in source.getbands(), "Alpha source channel missing")
    image = source.convert("RGBA" if alpha else "RGB")
    if image.size != (size, size):
        image = image.resize((size, size), Image.Resampling.LANCZOS)
    output = BytesIO()
    parameters = {"lossless": True, "method": 6, "exact": True} if alpha else {"quality": 95, "method": 6}
    image.save(output, "WEBP", **parameters)
    encoded = output.getvalue()
    decoded = Image.open(BytesIO(encoded)).convert(image.mode)
    require(decoded.size == (size, size), "Encoded texture dimensions changed")
    report = {"file": file, "sha256": sha(encoded), "bytes": len(encoded), "width": size, "height": size,
              "sourceWidth": source_size[0], "sourceHeight": source_size[1], "sourceMode": source_mode,
              "mode": image.mode, "encoding": {"format": "WebP", **parameters}}
    if alpha:
        require(image.tobytes() == decoded.tobytes(), "Lossless alpha texture pixel mismatch")
        extrema = decoded.getchannel("A").getextrema()
        require(extrema[0] < 32 and extrema[1] > 224, "Alpha mask lacks transparent/opaque detail")
        report.update({"alphaRange": list(extrema), "losslessResizedPixelComparison": "PASS"})
    else:
        rms = ImageStat.Stat(ImageChops.difference(image, decoded)).rms
        require(max(rms) < 8, "Skin WebP compression error exceeds declared RMS bound")
        report["decodedRGBRootMeanSquareError"] = rms
    return encoded, report


def source_metadata(directory):
    metadata = json.loads((directory / "selected-assets-manifest.json").read_text())
    require(metadata["archive_url"] == ARCHIVE_URL and metadata["etag"] == ETAG,
            "Unexpected official pack identity")
    require(metadata["archive_size"] == 280737770 and metadata["zip_entry_count"] == 517,
            "Unexpected official pack size/index")
    require(metadata["central_directory"]["sha256"] == DIRECTORY_SHA, "Unexpected central directory hash")
    records, content = [], {}
    for name, crc in PINNED.items():
        declared = next((entry for entry in metadata["entries"] if entry["name"] == name), None)
        require(declared is not None, "Selected source not yet verified: " + name)
        raw = (directory / name).read_bytes()
        require(f"{zlib.crc32(raw) & 0xffffffff:08x}" == declared["crc"] == crc, "Source CRC mismatch: " + name)
        require(len(raw) == declared["size"] and sha(raw) == declared["sha256"] == PINNED_SHA[name],
                "Source identity mismatch: " + name)
        if name.endswith((".mhmat", ".mhclo", ".obj")):
            require(b"This asset was explicitly released as CC0 in september 2020" in raw,
                    "Embedded core CC0 declaration missing: " + name)
        record = {key: declared[key] for key in ["name", "crc", "size", "compressed", "offset", "method", "sha256"]}
        record["license"] = "CC0-1.0 (official core assetpack listing and embedded asset metadata)"
        records.append(record)
        content[name] = raw
    archive = {key: metadata[key] for key in ["archive_url", "archive_size", "etag", "last_modified", "zip_entry_count", "central_directory"]}
    archive.update({"version": "Official CC0 core pack; Last-Modified 2024-04-14; pinned ETag and central directory",
                    "licenseListingURL": LISTING_URL, "wholeArchiveSHA256": None,
                    "retrieval": "Selected HTTP byte ranges; CRC and SHA256 verified per decompressed ZIP entry; whole archive not downloaded"})
    listing = metadata.get("retained_official_listing")
    require(listing and listing["sha256"] == "8340b6b8d33fa20b6668b482990bda99d790e0220c4a8f1c6d25e2fcf9bf3a27",
            "Official listing evidence missing or changed")
    require(sha((directory / "official-assetpack-listing.html").read_bytes()) == listing["sha256"],
            "Retained official assetpack listing hash mismatch")
    archive["officialListingEvidence"] = {"url": LISTING_URL, "sha256": listing["sha256"], "bytes": listing["bytes"]}
    return archive, records, content


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", required=True, type=Path)
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=ASSETS)
    parser.add_argument("--check", action="store_true", help="Regenerate/validate all output bytes without writing")
    args = parser.parse_args()
    archive, sources, content = source_metadata(args.sources)
    base_raw = args.base.read_bytes()
    require(sha(base_raw) == BASE_SHA, "Expected pinned MakeHuman core base.obj")
    require(sha((ASSETS / "LICENSE-CC0.txt").read_bytes()) == LICENSE_SHA, "Retained CC0 license mismatch")
    base = [tuple(map(float, line.split()[1:4])) for line in base_raw.decode().splitlines() if line.startswith("v ")]
    base_vertices = [world(point) for point in base if point[1] > 5.68]
    hair, brows = [read_obj(content[name + ".obj"], content[name + ".mhclo"], base)
                   for name in ["hair/short01/short01", "eyebrows/eyebrow001/eyebrow001"]]
    # Guard the regression where raw authoring OBJ coordinates float above the
    # target neutral scalp/eyes. Actual positions come from each MHCLO mapping.
    require(1.82 < bounds(hair["position"])["max"][1] < 1.84, "Hair not fitted to the pinned neutral scalp")
    require(1.67 < bounds(brows["position"])["min"][1] < bounds(brows["position"])["max"][1] < 1.69,
            "Brows not fitted immediately above the pinned eye sockets")
    for geometry in [hair, brows]:
        bb = bounds(geometry["position"])
        require(bb["min"][1] > 1.57 and bb["max"][1] < 1.85 and max(abs(x) for p in geometry["position"] for x in [p[0], p[2]]) < .25,
                "Accessory bounds outside anatomical head neighbourhood")
    glb, meshes = build_glb(hair, brows)
    output = {"review-player-hair.glb": glb}
    exports = [{"file": "review-player-hair.glb", "sha256": sha(glb), "bytes": len(glb), "meshes": meshes,
                "triangles": sum(mesh["triangles"] for mesh in meshes),
                "validation": ["GLB chunk/accessor bounds and finite values", "unit smooth normals",
                               "every indexed corner exactly matches transformed MHCLO fitted position and source glTF UV",
                               "neutral hair top below1.84m and brow surface between1.67m and1.69m",
                               "named hair/brow meshes and in-range triangle indices"]}]
    for source, file, size, alpha in [
        ("skins/young_caucasian_male/young_lightskinned_male_diffuse.png", "review-skin-basecolor.webp", 2048, False),
        ("hair/short01/short01_diffuse.png", "review-hair.webp", 1024, True),
        ("eyebrows/eyebrow001/eyebrow001.png", "review-brows.webp", 512, True),
    ]:
        encoded, report = texture(content[source], file, size, alpha)
        output[file] = encoded
        exports.append({"sourceAsset": source, **report})
    notices = ["MakeHuman selected core asset source notices", "", "Official CC0 listing: " + LISTING_URL,
               "Archive: " + ARCHIVE_URL, "ETag: " + ETAG, "Retained CC0 legal text: LICENSE-CC0.txt", ""]
    for name, raw in content.items():
        if name.endswith((".mhmat", ".mhclo")):
            # Preserve the original consecutive comment header verbatim.
            header = []
            for line in raw.decode().splitlines(keepends=True):
                if line.startswith("#"):
                    header.append(line)
                else:
                    break
            notices.extend(["Source: " + name, "SHA256: " + sha(raw), "".join(header), ""])
    notice_bytes = ("\n".join(notices).rstrip("\n") + "\n").encode()
    output["review-player-source-notices.txt"] = notice_bytes
    exports.append({"file": "review-player-source-notices.txt", "sha256": sha(notice_bytes),
                    "bytes": len(notice_bytes), "retainedSourceHeaders": 5})
    manifest = {"schemaVersion": 1, "exportVersion": "original-football-review-player-cc0-v2-mhclo-fit",
                "authoringScriptSHA256": sha(Path(__file__).read_bytes()),
                "software": {"Pillow": PIL.__version__, "libwebp": features.version("webp")},
                "archive": archive, "sources": sources,
                "baseCoordinateReference": {"sha256": BASE_SHA, "commit": "a8bc2d54ff0ac92e78ff71431b1023eda42bf482",
                                             "transform": "[x*.12, 1.50+(y-5.89)*.12, (z-.161)*.12]",
                                             "sourceVerticesAboveNeckWorldBounds": bounds(base_vertices)},
                "license": {"id": "CC0-1.0", "retainedLicenseFile": "LICENSE-CC0.txt", "licenseSHA256": LICENSE_SHA,
                            "retainedSourceNotices": "review-player-source-notices.txt",
                            "basis": "Official CC0 assetpack listing plus explicit September 2020 CC0 declaration embedded in every selected OBJ/material/fitting file",
                            "sourceHolders": ["Data Collection AB", "Joel Palmius", "Jonas Hauquier"]},
                "runtimeContract": {"meshes": ["review-hair", "review-brows"], "positions": "MHCLO neutral fitting to pinned base, then review-head world transform; raw authoring OBJ positions are not used",
                                    "uv": "TEXCOORD_0 / Three uv; source [u,1-v]; texture.flipY=false",
                                    "skinTexture": "2048px core body atlas; use review-head-high.glb TEXCOORD_1/uv1 channel=1, flipY=false",
                                    "binding": "Geometry remains unskinned; runtime supplies head-bone indices/weights and existing rig binding",
                                    "materials": "Runtime assigns hair/brow alpha textures, double-sided rendering and alpha test; placeholder GLB materials have no texture fetches"},
                "reproduce": "python3 scripts/assets/build-football-review-player.py --sources /path/to/core-assets --base /path/to/pinned/base.obj --check",
                "exports": exports,
                "limits": ["One selected neutral core hairstyle and brow asset; original roster and shipped heads are unchanged by processing.",
                           "MHCLO neutral hair top is approximately1.93cm above the pinned anatomical head; no dynamic hair simulation or collision fitting.",
                           "Hair/brows follow a single runtime head bone; no brow expression deformation is added by these assets.",
                           "Skin source material internal name says old_caucasian_male_detailed despite its young_caucasian_male folder; exact selected source identity is recorded without renaming the source.",
                           "No independent whole-archive hash is available because only selected verified ZIP ranges were downloaded.",
                           "Structural/pixel validation does not establish rendered visual, performance or physical-device acceptance."]}
    output["review-player-provenance.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    if args.check:
        for file, raw in output.items():
            require((args.output / file).read_bytes() == raw, "Export/manifest drift: " + file)
    else:
        args.output.mkdir(parents=True, exist_ok=True)
        for file, raw in output.items():
            (args.output / file).write_bytes(raw)
    print(json.dumps({"status": "PASS", "mode": "check" if args.check else "build", "exports": exports}, indent=2))


if __name__ == "__main__":
    main()
