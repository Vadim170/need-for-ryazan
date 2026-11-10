# Превью glb (Workbench, текстуры): blender -b --python preview.py -- <in.glb> <out.png> [yaw_deg] [elev_deg]
import bpy, sys, math
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
src, out = a[0], a[1]
yaw = math.radians(float(a[2]) if len(a) > 2 else 35); elev = math.radians(float(a[3]) if len(a) > 3 else 18)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
lo = Vector((1e9,) * 3); hi = Vector((-1e9,) * 3)
for o in bpy.data.objects:
    if o.type == 'MESH':
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
ctr = (lo + hi) / 2; r = (hi - lo).length / 2
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); bpy.context.scene.collection.objects.link(cam)
cam.data.lens = 50
d = r * 3.0
# перёд машины = +Y Blender
p = ctr + Vector((math.sin(yaw) * math.cos(elev), math.cos(yaw) * math.cos(elev), math.sin(elev))) * d
cam.location = p
cam.rotation_euler = (ctr - p).to_track_quat('-Z', 'Y').to_euler()
sc = bpy.context.scene; sc.camera = cam
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'
sc.display.shading.show_cavity = False
sc.render.resolution_x = 900; sc.render.resolution_y = 600
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
