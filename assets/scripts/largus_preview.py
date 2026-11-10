# blender -b --python largus_preview.py -- <in.gltf|glb> <outdir> [prefix]
import bpy, sys, math, os
from mathutils import Vector
argv=sys.argv[sys.argv.index('--')+1:]
src,outdir=argv[0],argv[1]; prefix=argv[2] if len(argv)>2 else 'v'
os.makedirs(outdir,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
objs=[o for o in bpy.data.objects if o.type=='MESH']
mn=Vector((1e9,)*3); mx=Vector((-1e9,)*3)
for o in objs:
    for c in o.bound_box:
        w=o.matrix_world@Vector(c)
        mn=Vector(map(min,mn,w)); mx=Vector(map(max,mx,w))
print('BBOX',mn,mx)
ctr=(mn+mx)/2; size=(mx-mn).length
sc=bpy.context.scene
try: sc.render.engine='BLENDER_EEVEE'
except Exception: sc.render.engine='BLENDER_EEVEE_NEXT'
w=bpy.data.worlds.new('w'); w.use_nodes=True; w.node_tree.nodes['Background'].inputs[0].default_value=(0.55,0.65,0.8,1); w.node_tree.nodes['Background'].inputs[1].default_value=1.2; sc.world=w
sun=bpy.data.objects.new('sun',bpy.data.lights.new('sun','SUN')); sun.data.energy=4; sun.rotation_euler=(0.9,0.2,0.6); sc.collection.objects.link(sun)
g=bpy.data.objects.new('g',bpy.data.meshes.new('g')); 
import bmesh as _b
_bm=_b.new(); _b.ops.create_grid(_bm,x_segments=1,y_segments=1,size=30); _bm.to_mesh(g.data); sc.collection.objects.link(g)
sc.render.resolution_x=1200; sc.render.resolution_y=700
cam=bpy.data.objects.new('cam',bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera=cam
cam.data.lens=50
views={'iso':(1,-1,0.45),'iso2':(-1,1,0.45),'side':(1,0,0.05),'rear':(0,1,0.3),'front':(0.4,-1,0.2)}
for n,d in views.items():
    d=Vector(d).normalized()
    cam.location=ctr+d*size*1.25
    cam.rotation_euler=(ctr-cam.location).to_track_quat('-Z','Y').to_euler()
    sc.render.filepath=os.path.join(outdir,f'{prefix}_{n}.png'); bpy.ops.render.render(write_still=True)
