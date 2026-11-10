import json,sys,numpy as np
d=sys.argv[1]
g=json.load(open(d+'/scene.gltf')); buf=open(d+'/scene.bin','rb').read()
def acc(i):
    a=g['accessors'][i]; bv=g['bufferViews'][a['bufferView']]
    n={'VEC3':3,'SCALAR':1,'VEC2':2}[a['type']]
    dt={5126:np.float32,5123:np.uint16,5125:np.uint32}[a['componentType']]
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    st=bv.get('byteStride')
    if st and st!=n*np.dtype(dt).itemsize:
        raw=np.frombuffer(buf,dtype=np.uint8,count=st*a['count'],offset=off).reshape(a['count'],st)
        return raw[:,:n*np.dtype(dt).itemsize].copy().view(dt).reshape(a['count'],n)
    return np.frombuffer(buf,dtype=dt,count=a['count']*n,offset=off).reshape(a['count'],n)
def M(n):
    if 'matrix' in n: return np.array(n['matrix']).reshape(4,4).T
    m=np.eye(4)
    if 'scale' in n: m=np.diag(list(n['scale'])+[1])
    return m
out=[]
def walk(i,P,path):
    n=g['nodes'][i]; W=P@M(n); p=path+[n.get('name','')]
    if 'mesh' in n:
        for pr in g['meshes'][n['mesh']]['primitives']:
            pos=acc(pr['attributes']['POSITION']); ph=np.c_[pos,np.ones(len(pos))]@W.T
            tri=g['accessors'][pr['indices']]['count']//3 if 'indices' in pr else len(pos)//3
            out.append((i,'/'.join(p[-3:]),pr.get('material'),tri,ph[:,:3].min(0),ph[:,:3].max(0)))
    for c in n.get('children',[]): walk(c,W,p)
for r in g['scenes'][0]['nodes']: walk(r,np.eye(4),[])
tot=sum(o[3] for o in out); print('prims',len(out),'tris',tot)
allmin=np.min([o[4] for o in out],0); allmax=np.max([o[5] for o in out],0); print('bbox',allmin,allmax)
for o in sorted(out,key=lambda o:-o[3]):
    print(o[0],o[1][-40:],'mat',o[2],g['materials'][o[2]]['name'] if o[2] is not None else '','tri',o[3],np.round(o[4],2),np.round(o[5],2))
