# Сборка hero-модели (docs/stage2/landmarks.md):
#   blender -b --python assets/scripts/landmarks/build_landmark.py -- <id> <raw_out_dir> [--lods 0,1] [--tex0 2048] [--tex1 1024] [--preview]
# Модель описана в assets/scripts/landmarks/<id>.py (функция build(lod) -> (meshes, collider_boxes, info)).
# Выход: <raw>/<id>_raw.glb, <id>_lod1_raw.glb, текстуры *_albedo.png / *_emit.png, <id>.json (метаданные), превью *.png.
# Дальше: sh assets/scripts/landmarks/pack_landmark.sh <raw_out_dir> <id> (webp + meshopt → game/public/assets/landmarks/<id>/).
import sys, os, json, importlib, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector
import lmlib as L

argv = sys.argv[sys.argv.index('--') + 1:]
MID, OUT = argv[0], os.path.abspath(argv[1])
opts = {'lods': '0,1', 'tex0': '2048', 'tex1': '1024', 'preview': None, 'dist': '1.15'}
i = 2
while i < len(argv):
    k = argv[i].lstrip('-')
    if k == 'preview':
        opts['preview'] = '1'; i += 1
    else:
        opts[k] = argv[i + 1]; i += 2
os.makedirs(OUT, exist_ok=True)
mod = importlib.import_module(MID)
res = {}
for lod in [int(x) for x in opts['lods'].split(',')]:
    info = L.run(mod.build, MID, OUT, lod, int(opts['tex0'] if lod == 0 else opts['tex1']))
    res[f'lod{lod}'] = {'triangles': info['triangles'], 'tex': info['tex']}
    res.update({k: v for k, v in info.items() if k not in ('triangles', 'tex')})
    if opts['preview']:
        sc = bpy.context.scene
        sc.render.engine = 'BLENDER_EEVEE'
        sc.render.resolution_x, sc.render.resolution_y = 1280, 800
        w = sc.world or bpy.data.worlds.new('w'); sc.world = w
        w.use_nodes = True
        bg = w.node_tree.nodes.get('Background')
        bg.inputs['Color'].default_value = (0.55, 0.68, 0.85, 1); bg.inputs['Strength'].default_value = 0.9
        sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
        sun.data.energy = 3.5; sun.rotation_euler = (math.radians(50), 0, math.radians(200))
        sc.collection.objects.link(sun)
        sx, sz, sy = info['size']
        bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, -0.02))
        gm = bpy.data.materials.new('ground'); gm.use_nodes = True
        gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.25, 0.25, 0.24, 1)
        bpy.context.active_object.data.materials.append(gm)
        cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
        cam.data.lens = 24
        sc.collection.objects.link(cam); sc.camera = cam
        R = max(sx, sy) * float(opts.get('dist', 1.15))
        def emission(k):
            for m in bpy.data.materials:
                if m.use_nodes:
                    for n in m.node_tree.nodes:
                        if n.type == 'BSDF_PRINCIPLED' and n.inputs['Emission Color'].is_linked:
                            n.inputs['Emission Strength'].default_value = k
        views = (('front', 30, 1.7, 0), ('side', 95, 1.7, 0), ('back', 200, 1.7, 0), ('aerial', 50, R * 0.6, 0), ('night', 15, 1.7, 1))
        for name, az, h, night in views:
            emission(2.0 if night else 0.0)
            bg.inputs['Strength'].default_value = 0.03 if night else 0.9
            sun.data.energy = 0.05 if night else 3.5
            a = math.radians(az)
            cam.location = (R * math.sin(a), R * math.cos(a), h)
            d = Vector((0, 0, sz * 0.4)) - cam.location
            cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
            sc.render.filepath = os.path.join(OUT, f'{MID}_lod{lod}_{name}.png')
            bpy.ops.render.render(write_still=True)
json.dump(res, open(os.path.join(OUT, MID + '.json'), 'w'), ensure_ascii=False, indent=1)
L.log('готово', res)
