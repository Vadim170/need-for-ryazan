# Рендер hero-модели из поз камер панорам (pipeline/landmark_compare.py): blender -b --python compare_render.py -- <cams.json>
import bpy, sys, json, math, os
from mathutils import Euler
cfg = json.load(open(sys.argv[sys.argv.index('--') + 1]))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=cfg['glb'])
for o in list(bpy.data.objects):
    if o.name.startswith('collider'):
        bpy.data.objects.remove(o)
for m in bpy.data.materials:   # день: без свечения
    if m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED':
                n.inputs['Emission Strength'].default_value = 0.0
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 1280, 900
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.45, 0.62, 0.9, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 4.0
sun.rotation_euler = (math.radians(40), 0, math.radians(160)); sc.collection.objects.link(sun)
bpy.ops.mesh.primitive_plane_add(size=800, location=(0, 0, -0.03))
g = bpy.data.materials.new('g'); g.use_nodes = True
g.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.3, 0.3, 0.29, 1)
bpy.context.active_object.data.materials.append(g)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.sensor_fit = 'HORIZONTAL'
os.makedirs(cfg['out'], exist_ok=True)
for c in cfg['cams']:
    cam.data.angle = math.radians(c['hfov'])
    cam.location = (c['x'], c['y'], c['z'])
    # yaw: азимут взгляда относительно переда модели (+Y), по часовой; камера Blender смотрит вдоль −Z
    cam.rotation_euler = Euler((math.radians(90 + c['pitch']), 0, -math.radians(c['yaw'])), 'XYZ')
    sc.render.filepath = os.path.join(cfg['out'], f"{c['k']:02d}.png")
    bpy.ops.render.render(write_still=True)
