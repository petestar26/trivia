# Retained CC0 garment bump source

`T-shirt_basic-bump.png` and `t_shirt_basic_tucked.mhmat` are retained unchanged
from `clothes/toigo_basic_tucked_t-shirt/` in the MakeHuman Shirts 01 CC0 pack.
The original author is MargaretToigo (embedded garment author: MRT).

- Official listing: https://static.makehumancommunity.org/assets/assetpacks/shirts01.html
- Full archive: https://files.makehumancommunity.org/asset_packs/shirts01/shirts01_cc0.zip
- Full archive SHA256: `a5a723b0e84a109bb190fcfeac7f1de4138d875da3e30fe5b3340eac9f38bcd3`
- PNG SHA256: `dfe923b14a9188857d12eb227ceb6365dcf1ec3cd97e42f30c6fe3ae2c474578`; archive CRC32 `cc38f708`.
- Material SHA256: `44098003a7ed47cd4c613d04adcdccaae47fe0d2b380bf3c25f105a739814f94`; archive CRC32 `6777dd57`.
- CC0 legal text: `apps/web/public/models/football/LICENSE-CC0.txt`.

The material explicitly names `T-shirt_basic-bump.png` as its bump texture.
This artist source contains ribbed collar/cuff strips; its shirt panels are flat.
It is a height image, not a normal map or a complete PBR material package.
The original diffuse is intentionally not used for the fictional club kit.

The original source remains editable and unchanged. The runtime derivative is
1024px grayscale, Lanczos downsampled, lossless WebP. The script
`scripts/assets/build-football-review-materials.py --check` verifies the pinned
source and byte identity of the derivative. Runtime uses linear sampling,
`flipY=false`, channel 0 and the garment's original OBJ UV corners, independently
of its projected fictional color/number atlas. Bump scale is an original artistic
calibration in `review-material-study.json`, not a measured fabric displacement.

Existing source skin/hair/brow identities and their licenses remain documented
in `review-player-provenance.json`; no new human scan or external asset is added.
