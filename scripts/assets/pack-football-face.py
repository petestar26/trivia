"""Extract the CC0 MakeHuman facial surface, no app code, helpers, body or textures.
Usage: python3 scripts/assets/pack-football-face.py path/to/base.obj
Pinned source and licence: docs/games/virtual-football-visual-assets.md.
"""
import sys,struct,json,pathlib,hashlib
raw=pathlib.Path(sys.argv[1]).read_bytes()
if hashlib.sha256(raw).hexdigest() != '8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c':
    raise SystemExit('Expected the pinned CC0 MakeHuman base.obj documented in visual assets')
verts=[];faces=[];group=''
for line in raw.decode().splitlines():
    a=line.split()
    if not a:continue
    if a[0]=='v':verts.append(tuple(map(float,a[1:4])))
    if a[0]=='g':group=a[1]
    if a[0]=='f' and group=='body':
        ids=[int(v.split('/')[0])-1 for v in a[1:]]
        if all(verts[i][1]>5.68 for i in ids):
            for n in range(1,len(ids)-1):faces.extend([ids[0],ids[n],ids[n+1]])
used=sorted(set(faces));remap={n:i for i,n in enumerate(used)}
pos=[(verts[i][0]*.12,1.50+(verts[i][1]-5.89)*.12,(verts[i][2]-.161)*.12)for i in used]
positions=b''.join(struct.pack('<fff',*p)for p in pos);indices=b''.join(struct.pack('<H',remap[i])for i in faces)
binary=positions+indices;binary+=b'\0'*((-len(binary))%4)
j={'asset':{'version':'2.0','generator':'PlayQube CC0 facial surface extraction'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0,'name':'MakeHuman CC0 face'}],'meshes':[{'primitives':[{'attributes':{'POSITION':0},'indices':1}]}],'buffers':[{'byteLength':len(binary)}],'bufferViews':[{'buffer':0,'byteOffset':0,'byteLength':len(positions)},{'buffer':0,'byteOffset':len(positions),'byteLength':len(indices)}],'accessors':[{'bufferView':0,'componentType':5126,'count':len(pos),'type':'VEC3','min':[min(p[k]for p in pos)for k in range(3)],'max':[max(p[k]for p in pos)for k in range(3)]},{'bufferView':1,'componentType':5123,'count':len(faces),'type':'SCALAR'}]}
s=json.dumps(j,separators=(',',':')).encode();s+=b' '*((-len(s))%4)
out=struct.pack('<III',0x46546c67,2,28+len(s)+len(binary))+struct.pack('<II',len(s),0x4e4f534a)+s+struct.pack('<II',len(binary),0x004e4942)+binary
pathlib.Path('apps/web/public/models/football/face.glb').write_bytes(out)
print('source',hashlib.sha256(raw).hexdigest(),'vertices',len(pos),'triangles',len(faces)//3,'bytes',len(out),'sha256',hashlib.sha256(out).hexdigest())
