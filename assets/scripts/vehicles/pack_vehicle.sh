#!/bin/sh
# Упаковка сырых glb из build_vehicle.py: текстуры WebP (LOD0 ≤ 1024, LOD1 ≤ 256), dedup/prune, meshopt.
#   sh assets/scripts/vehicles/pack_vehicle.sh <raw_dir> <id> [out_root=game/public/assets/vehicles]
set -e
RAW="$1"; ID="$2"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUTROOT="${3:-$ROOT/game/public/assets/vehicles}"
OUT="$OUTROOT/$ID"; mkdir -p "$OUT"
GT="npx -y @gltf-transform/cli"
pack() { # src dst size
  $GT dedup "$1" "$RAW/_a.glb" --materials false >/dev/null
  $GT prune "$RAW/_a.glb" "$RAW/_b.glb" >/dev/null
  $GT resize "$RAW/_b.glb" "$RAW/_c.glb" --width "$3" --height "$3" >/dev/null
  $GT webp "$RAW/_c.glb" "$RAW/_d.glb" --quality 86 >/dev/null
  $GT meshopt "$RAW/_d.glb" "$2" --level medium >/dev/null
  rm -f "$RAW/_a.glb" "$RAW/_b.glb" "$RAW/_c.glb" "$RAW/_d.glb"
}
pack "$RAW/${ID}_raw.glb" "$OUT/$ID.glb" "${TEX0:-1024}"
pack "$RAW/${ID}_lod1_raw.glb" "$OUT/${ID}_lod1.glb" "${TEX1:-256}"
cp "$RAW/$ID.json" "$OUT/build.json"
ls -l "$OUT"
