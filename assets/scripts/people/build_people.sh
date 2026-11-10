#!/usr/bin/env bash
# Полная сборка пешеходов: персонажи (Blender + MPFB2) -> WebP + meshopt -> клипы (CMU BVH) -> people.json.
#
# Требуется (один раз, см. docs/stage2/models.md, раздел «Люди»):
#   - MPFB2 v2.0.18, установлен изолированно: BLENDER_USER_RESOURCES=assets/tools/blender-user
#       blender -c extension install-file -r user_default -e assets/downloads/mpfb/add-on-mpfb-v2.0.18.zip
#   - ассет-паки MakeHuman (CC0) распакованы в assets/tools/blender-user/extensions/.user/user_default/mpfb/data
#   - BVH CMU (cgspeed) в assets/downloads/cmu/bvh
#   - node (npx @gltf-transform/cli)
# Запуск из корня репозитория:  bash assets/scripts/people/build_people.sh [id ...]   (без id — все персонажи)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
SPEC=assets/scripts/people/characters.json
BUILD=assets/build/people
OUT=game/public/assets/people
mkdir -p "$BUILD" "$OUT"
export BLENDER_USER_RESOURCES="$ROOT/assets/tools/blender-user"
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
GT="npx -y @gltf-transform/cli@4.5.1"

IDS=("$@")
if [ ${#IDS[@]} -eq 0 ]; then
  IDS=($(python3 -I -c "import json,sys;print(' '.join(c['id'] for c in json.load(open(sys.argv[1]))['characters']))" "$SPEC"))
fi
for id in "${IDS[@]}"; do
  echo "== $id"
  blender -b --python assets/scripts/people/build_character.py -- --spec "$SPEC" --id "$id" --out "$BUILD" 2>&1 \
    | grep -E "^\[char\]|Error|Traceback" || true
  [ -f "$BUILD/$id.glb" ] || { echo "сборка $id не удалась"; exit 1; }
  $GT webp "$BUILD/$id.glb" "$BUILD/$id.webp.glb" --quality 82 >/dev/null 2>&1
  $GT meshopt "$BUILD/$id.webp.glb" "$OUT/$id.glb" --level medium >/dev/null 2>&1
  rm -f "$BUILD/$id.webp.glb"
  ls -la "$OUT/$id.glb"
done
python3 -I assets/scripts/people/build_clips.py assets/downloads/cmu/bvh "$BUILD"
python3 -I assets/scripts/people/make_manifest.py "$BUILD" "$OUT" "$SPEC"
du -sh "$OUT"
