#!/bin/sh
# Полная сборка одной модели: build_vehicle.py → pack_vehicle.sh → make_manifest.mjs
#   sh assets/scripts/vehicles/build_all.sh <id> [tmp=/tmp/nfr-veh]
set -e
ID="$1"; TMP="${2:-/tmp/nfr-veh}/$ID"
D="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$TMP"
blender -b --python "$D/build_vehicle.py" -- "$D/configs/$ID.json" "$TMP" 2>&1 | grep -E "^\[build_vehicle\]|Error|Traceback" || true
[ -f "$TMP/${ID}_raw.glb" ] || { echo "сборка $ID не удалась"; exit 1; }
sh "$D/pack_vehicle.sh" "$TMP" "$ID" | tail -3
blender -b --python "$D/preview.py" -- "$TMP/${ID}_raw.glb" "$TMP/${ID}_preview.png" >/dev/null 2>&1 || true
blender -b --python "$D/preview.py" -- "$TMP/${ID}_lod1_raw.glb" "$TMP/${ID}_lod1_preview.png" >/dev/null 2>&1 || true
node "$D/make_manifest.mjs"
