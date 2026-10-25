"""Reproduce the review shirt bump from its retained CC0 artist source.

No network or synthetic texture generation. Pillow retains a lossless 1024px
grayscale derivative of the original 2048px height map. --check compares bytes.
"""
import argparse
import hashlib
import json
from io import BytesIO
from pathlib import Path

from PIL import Image, __version__ as pillow_version, features

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/assets/sources/football-review-materials/T-shirt_basic-bump.png'
OUTPUT = ROOT / 'apps/web/public/models/football/review-shirt-bump.webp'
MANIFEST = ROOT / 'apps/web/public/models/football/review-material-provenance.json'
STUDY = ROOT / 'apps/web/src/components/football/engine/review-material-study.json'
PINNED = 'dfe923b14a9188857d12eb227ceb6365dcf1ec3cd97e42f30c6fe3ae2c474578'

if __name__ == '__main__':
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == PINNED, 'Source identity mismatch'
    image = Image.open(SOURCE)
    assert image.size == (2048, 2048) and image.mode == 'RGBA'
    assert image.getextrema()[3] == (255, 255), 'Unexpected source transparency'
    result = BytesIO()
    image.convert('L').resize((1024, 1024), Image.Resampling.LANCZOS).save(result, format='WEBP', lossless=True)
    study = json.loads(STUDY.read_bytes())
    manifest = {
        'source': {
            'author': 'MargaretToigo / MRT',
            'license': 'CC0',
            'listing': 'https://static.makehumancommunity.org/assets/assetpacks/shirts01.html',
            'archive': 'https://files.makehumancommunity.org/asset_packs/shirts01/shirts01_cc0.zip',
            'archiveSha256': 'a5a723b0e84a109bb190fcfeac7f1de4138d875da3e30fe5b3340eac9f38bcd3',
            'entry': 'clothes/toigo_basic_tucked_t-shirt/T-shirt_basic-bump.png',
            'entryCRC32': 'cc38f708',
            'sha256': PINNED,
            'retained': str(SOURCE.relative_to(ROOT)),
            'dimensions': [2048, 2048],
            'role': 'Original artist height image for ribbed cuff/collar strips; flat shirt panels',
        },
        'derivative': {
            'file': OUTPUT.name,
            'sha256': hashlib.sha256(result.getvalue()).hexdigest(),
            'bytes': len(result.getvalue()),
            'dimensions': [1024, 1024],
            'process': 'RGBA to grayscale L, Lanczos resize, lossless WebP',
            'pillow': pillow_version,
            'libwebp': features.version('webp'),
            'colorSpace': 'linear / Three NoColorSpace',
            'flipY': False,
            'uvChannel': 0,
            'uvSource': 'Original OBJ garment UVs retained through MHCLO fitting and tailoring',
            'bumpScaleMetres': study['shirt']['bumpScaleMetres'],
            'estimatedRgbaMipBytes': 5592404,
        },
        'originalStudy': {
            'file': str(STUDY.relative_to(ROOT)),
            'bytes': len(STUDY.read_bytes()),
            'sha256': hashlib.sha256(STUDY.read_bytes()).hexdigest(),
            'authorship': study['authorship'],
        },
        'scope': 'One existing fixed review actor; no full PBR artist package, scan, cloth simulation or new groom',
        'scriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
    if args.check:
        assert result.getvalue() == OUTPUT.read_bytes(), 'Derived texture is stale'
        assert manifest_bytes == MANIFEST.read_bytes(), 'Material provenance is stale'
    else:
        OUTPUT.write_bytes(result.getvalue())
        MANIFEST.write_bytes(manifest_bytes)
    print(f'{OUTPUT.name}: {len(result.getvalue())} bytes; sha256 {hashlib.sha256(result.getvalue()).hexdigest()}')
