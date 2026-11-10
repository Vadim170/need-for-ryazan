#!/bin/sh
# meshopt-сжатие сырых GLB из build_largus.py. Использование: pack_largus.sh <raw_dir> <out_dir>
set -e
RAW="$1"; OUT="$2"; mkdir -p "$OUT"
for n in largus largus_lod1; do
  src="$RAW/${n}_raw.glb"
  npx -y @gltf-transform/cli dedup "$src" "$RAW/${n}_a.glb"
  npx -y @gltf-transform/cli prune "$RAW/${n}_a.glb" "$RAW/${n}_b.glb"
  npx -y @gltf-transform/cli meshopt "$RAW/${n}_b.glb" "$OUT/${n}.glb" --level high
done
ls -l "$OUT"
