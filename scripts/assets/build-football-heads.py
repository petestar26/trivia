"""Original deterministic head authoring/export; Python stdlib only.
Usage: python3 scripts/assets/build-football-heads.py path/to/pinned/base.obj
The only imported asset is the individually pinned MakeHuman CC0 core base.obj.
No MakeHuman/MPFB application source, third-party hair, texture or target is used.
"""
from __future__ import annotations
import argparse, collections, hashlib, heapq, json, math, pathlib, struct, sys
SOURCE_SHA='8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c'
LICENSE_SHA='f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c'
COMMIT='a8bc2d54ff0ac92e78ff71431b1023eda42bf482'
TARGETS=['blinkLeft','blinkRight','jawOpen','browRaise','smile','noseWidth','lipFullness','earSize']
PARTS={'skin':0,'lip':1,'socket':2,'sclera':3,'iris':4,'pupil':5,'brow':6,'mouthInterior':7}
EYE=[.30775,7.28415,1.24535]; EYE_RADIUS=.14665; PUPIL_RADIUS=.002/.12

def sub(a,b):return [a[k]-b[k]for k in range(3)]
def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def dot(a,b):return sum(x*y for x,y in zip(a,b))
def norm(a):return math.sqrt(dot(a,a))
def unit(a):
 n=norm(a);return [x/n for x in a]if n>1e-14 else [0.,0.,1.]
def smooth(a,b,x):
 t=min(1,max(0,(x-a)/(b-a)));return t*t*(3-2*t)
def gauss(x,y,cx,cy,rx,ry):return math.exp(-((x-cx)/rx)**2-((y-cy)/ry)**2)
def world(p):return [p[0]*.12,1.5+(p[1]-5.89)*.12,(p[2]-.161)*.12]
def read_obj(path):
 raw=path.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=SOURCE_SHA:raise ValueError('Expected individually pinned CC0 base.obj')
 v=[];faces=[];group=''
 for line in raw.decode().splitlines():
  a=line.split()
  if not a:continue
  if a[0]=='v':v.append(list(map(float,a[1:4])))
  elif a[0]=='g':group=a[1]
  elif a[0]=='f'and group=='body':
   ids=[int(s.split('/')[0])-1 for s in a[1:]]
   if all(v[i][1]>5.68 for i in ids):
    for n in range(1,len(ids)-1):faces.append((ids[0],ids[n],ids[n+1]))
 used=sorted(set(i for f in faces for i in f));remap={s:i for i,s in enumerate(used)}
 return [v[i]for i in used],[tuple(remap[i]for i in f)for f in faces],used

def anatomical_weight(p):
 x,y,z=p; ax=abs(x)
 # Preserve sockets/lid folds, nose ridge/nostrils, vermilion and ear folds first.
 eye=gauss(ax,y,.31,7.285,.20,.14)*smooth(1.20,1.34,z)
 nose=gauss(x,y,0,6.98,.18,.23)*smooth(1.35,1.50,z)
 lips=gauss(x,y,0,6.645,.26,.10)*smooth(1.35,1.48,z)
 ear=smooth(.64,.88,ax)*smooth(6.60,6.90,y)*(1-smooth(7.45,7.75,y))
 return 1+60*eye+30*nose+45*lips+18*ear

def simplify(vertices, triangles, target, protected):
 """Priority-weighted quadric collapse with fold rejection and protected feature loops.
 High never passes through this function. Mid keeps explicit inner lid loops intact;
 low is only a distant silhouette mesh. No arbitrary uniform triangle thinning.
 """
 v=[p[:]for p in vertices]; fs=[list(f)for f in triangles]; alive=[True]*len(v)
 vf=[set()for _ in v];q=[[0.]*16 for _ in v];version=[0]*len(v)
 for fi,f in enumerate(fs):
  a,b,c=[v[i]for i in f];n=unit(cross(sub(b,a),sub(c,a)));plane=n+[-dot(n,a)]
  weight=sum(anatomical_weight(v[i])for i in f)/3
  for i in f:
   vf[i].add(fi)
   for j in range(4):
    for k in range(4):q[i][j*4+k]+=plane[j]*plane[k]*weight
 count=len(fs);heap=[]
 def edges(i):return set(j for fi in vf[i]if fs[fi]is not None for j in fs[fi]if j!=i)
 def candidate(a,b):
  if a>b:a,b=b,a
  if not alive[a]or not alive[b]or(a in protected and b in protected):return
  opts=[v[a],v[b],[(v[a][k]+v[b][k])/2 for k in range(3)]]
  if a in protected:opts=[v[a]]
  if b in protected:opts=[v[b]]
  qq=[q[a][k]+q[b][k]for k in range(16)]
  def cost(p):
   h=p+[1.];return max(0,sum(qq[j*4+k]*h[j]*h[k]for j in range(4)for k in range(4)))+norm(sub(v[a],v[b]))**2*.0001*(anatomical_weight(p))
  p=min(opts,key=cost);heapq.heappush(heap,(cost(p),a,b,version[a],version[b],p[:]))
 for a in range(len(v)):
  for b in edges(a):
   if b>a:candidate(a,b)
 stalled=0
 while count>target and heap:
  _,a,b,va,vb,p=heapq.heappop(heap)
  if not alive[a]or not alive[b]or version[a]!=va or version[b]!=vb or b not in edges(a):continue
  affected=vf[a]|vf[b];valid=True
  # Reject collapses that flip or degenerate a surviving surface triangle.
  for fi in affected:
   f=fs[fi]
   if f is None or(a in f and b in f):continue
   old=[v[i]for i in f];new=[p if i in (a,b)else v[i]for i in f]
   no=cross(sub(old[1],old[0]),sub(old[2],old[0]));nn=cross(sub(new[1],new[0]),sub(new[2],new[0]))
   if norm(nn)<1e-10 or dot(unit(no),unit(nn))<.18:valid=False;break
  if not valid:stalled+=1;continue
  if b in protected:protected.remove(b);protected.add(a)
  old_neighbors=edges(a)|edges(b);alive[b]=False;v[a]=p;q[a]=[q[a][k]+q[b][k]for k in range(16)];version[a]+=1;version[b]+=1
  for fi in list(affected):
   f=fs[fi]
   if f is None:continue
   for i in f:vf[i].discard(fi)
   nf=[a if i==b else i for i in f]
   if len(set(nf))<3:fs[fi]=None;count-=1
   else:
    fs[fi]=nf
    for i in nf:vf[i].add(fi)
  vf[b].clear()
  for j in old_neighbors:
   if alive[j]:
    version[j]+=1
    for k in edges(j):candidate(j,k)
  for k in edges(a):candidate(a,k)
 used=sorted(set(i for f in fs if f is not None for i in f));remap={i:k for k,i in enumerate(used)}
 return [v[i]for i in used],[tuple(remap[i]for i in f)for f in fs if f is not None],{'requestedTriangles':target,'achievedTriangles':count,'foldRejections':stalled}

def part_for(p):
 x,y,z=p;ax=abs(x)
 if z>1.46 and abs(x)<.30 and 6.565<y<6.725:
  # Elliptical mask retains original cupid's bow geometry and avoids a rectangular patch.
  if ((x/.29)**2+((y-6.642)/.077)**2)<1.0:return PARTS['lip']
 if .16<ax<.46 and 7.235<y<7.345 and 1.29<z<1.41:return PARTS['socket']
 if abs(x)<.33 and 6.47<y<6.80 and z<1.18:return PARTS['mouthInterior']
 return PARTS['skin']

def blink_delta(p,side):
 x,y,z=p;cx=side*EYE[0];cy=EYE[1]
 if side*x<0 or z<1.26 or abs(x-cx)>.22 or abs(y-cy)>.20:return [0.,0.,0.]
 # The actual inner eyelid loop (source 7747..7772 and mirrored coordinates)
 # moves to a sloping closure seam; outer crease falloff anchors brow/cheek.
 seam=cy+.10*(side*x-EYE[0]); upper=y>seam
 # Weight is one through aperture, falls across existing lid crease rings.
 ry=.049 if upper else .050
 distance=abs(y-seam)
 w=1-smooth(ry, .145 if upper else .125,distance)
 w*=1-smooth(.125,.205,abs(x-cx))
 dy=(seam-y)*w
 radius_sq=EYE_RADIUS**2-(x-cx)**2
 seam_z=EYE[2]+math.sqrt(max(0,radius_sq))+.005
 dz=max(0,seam_z-z)*w
 return [0.,dy*.12,dz*.12]

def morph(p,part,name):
 x,y,z=p;ax=abs(x);d=[0.,0.,0.]
 if part not in (0,1,2,7,6):return d
 if name in ('blinkLeft','blinkRight'):
  return blink_delta(p,1 if name=='blinkLeft'else -1)if part!=6 else d
 if name=='jawOpen':
  w=(1-smooth(6.55,6.92,y))*smooth(-.2,.7,z)*(1-smooth(.50,.75,ax))
  d=[0,-.030*w,-.003*w]
 if name=='browRaise':
  w=gauss(ax,y,.31,7.49,.24,.16)*smooth(1.15,1.32,z);d=[0,.009*w,.001*w]
 if name=='smile':
  w=gauss(ax,y,.21,6.65,.17,.12)*smooth(1.25,1.43,z);d=[math.copysign(.005*w,x),.005*w,0]
 if name=='noseWidth':
  w=gauss(x,y,0,6.99,.23,.24)*smooth(1.33,1.49,z);d=[x*.12*.18*w,0,-.003*w]
 if name=='lipFullness':
  w=gauss(x,y,0,6.645,.29,.08)*smooth(1.35,1.48,z);d=[0,(y-6.645)*.12*.30*w,.003*w]
 if name=='earSize':
  w=smooth(.65,.85,ax)*smooth(6.5,6.83,y)*(1-smooth(7.45,7.70,y));d=[math.copysign(.009*w,x),(y-7.08)*.12*.16*w,.002*w]
 return d

def add_eye_cap(v,f,parts,c,seg,rings):
 # Only the anterior spherical eye surface is visible through the socket.
 # Omitting its hidden posterior hemisphere reduces cost without reducing lids.
 start=len(v);v.append([c[0],c[1],c[2]+EYE_RADIUS]);parts.append(PARTS['sclera'])
 for j in range(1,rings+1):
  phi=(math.pi*.46)*j/rings
  for i in range(seg):
   a=2*math.pi*i/seg
   v.append([c[0]+EYE_RADIUS*math.sin(phi)*math.cos(a),c[1]+EYE_RADIUS*math.sin(phi)*math.sin(a),c[2]+EYE_RADIUS*math.cos(phi)]);parts.append(PARTS['sclera'])
 for i in range(seg):f.append((start,start+1+i,start+1+(i+1)%seg))
 for j in range(1,rings):
  for i in range(seg):
   a=start+1+(j-1)*seg+i;b=start+1+(j-1)*seg+(i+1)%seg;c0=a+seg;d=b+seg;f.extend([(a,c0,b),(b,c0,d)])

def iris_detail(p):
 # Original radial fibre/limbal variation: analytic values, not an imported bitmap.
 cx=math.copysign(EYE[0],p[0]);dx=p[0]-cx;dy=p[1]-EYE[1];rad=math.hypot(dx,dy);angle=math.atan2(dy,dx)
 fibres=.12*math.sin(angle*17+rad*65)+.08*math.sin(angle*29-rad*38)
 limbal=1-.28*smooth(.047,.060,rad)
 return min(1.18,max(.58,(.96+fibres)*limbal))

def add_iris(v,f,parts,c,r,seg,rings):
 # A separate, coincident pupil boundary prevents a wide black-to-brown gradient.
 # The pupil has an explicit 2 mm radius in world metres at every LOD.
 start=len(v);v.append([c[0],c[1],c[2]+EYE_RADIUS+.0004]);parts.append(PARTS['pupil'])
 for i in range(seg):
  a=2*math.pi*i/seg;dx=PUPIL_RADIUS*math.cos(a);dy=PUPIL_RADIUS*math.sin(a)
  v.append([c[0]+dx,c[1]+dy,c[2]+math.sqrt(EYE_RADIUS**2-PUPIL_RADIUS**2)+.0006]);parts.append(PARTS['pupil'])
 for i in range(seg):f.append((start,start+1+i,start+1+(i+1)%seg))
 iris_start=len(v)
 for j in range(rings+1):
  rad=PUPIL_RADIUS+(r-PUPIL_RADIUS)*j/rings
  for i in range(seg):
   a=2*math.pi*i/seg;dx=rad*math.cos(a);dy=rad*math.sin(a)
   # 0.02 mm original fibre relief stays below the anterior corneal offset.
   relief=(.00002/.12)*math.sin(a*17+j*.7)*math.sin(math.pi*j/rings)
   v.append([c[0]+dx,c[1]+dy,c[2]+math.sqrt(EYE_RADIUS**2-rad**2)+.0006+relief]);parts.append(PARTS['iris'])
 for j in range(rings):
  for i in range(seg):
   a=iris_start+j*seg+i;b=iris_start+j*seg+(i+1)%seg;c0=a+seg;d=b+seg;f.extend([(a,c0,b),(b,c0,d)])

def normals(v,fs):
 n=[[0.,0.,0.]for _ in v]
 for f in fs:
  a,b,c=[v[i]for i in f];nn=cross(sub(b,a),sub(c,a))
  for i in f:
   for k in range(3):n[i][k]+=nn[k]
 return [unit(x)for x in n]

def export(path,v,fs,lod,source_count,decimation):
 parts=[part_for(p)for p in v];surface_count=len(v);surface_triangles=len(fs)
 seg,rings,irisrings={'high':(24,8,4),'mid':(16,6,4),'low':(8,3,2)}[lod]
 for side in (-1,1):
  c=[side*EYE[0],EYE[1],EYE[2]]
  add_eye_cap(v,fs,parts,c,seg,rings)
  add_iris(v,fs,parts,c,.060,seg,irisrings)
 # Fit original brows to the actual source forehead triangles, then lift 1.2mm.
 brow_triangles=[]
 for tri in fs[:surface_triangles]:
  a,b,c=[v[i]for i in tri]
  if max(p[1]for p in (a,b,c))<7.35 or min(p[1]for p in (a,b,c))>7.70 or max(p[2]for p in (a,b,c))<1.1:continue
  den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
  if abs(den)>1e-12:brow_triangles.append((a,b,c,den))
 def brow_point(x,y):
  best=None
  for a,b,c,den in brow_triangles:
   u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den
   w=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den;q=1-u-w
   if min(u,w,q)<-1e-7:continue
   z=u*a[2]+w*b[2]+q*c[2]
   if best is None or z>best[0]:
    normal=unit(cross(sub(b,a),sub(c,a)))
    if normal[2]<0:normal=[-n for n in normal]
    best=(z,normal)
  z,normal=best if best is not None else (1.46-.20*(abs(x)-.15)/.34,[0,0,1])
  return [x+normal[0]*.010,y+normal[1]*.010,z+normal[2]*.010]
 # Original brows: narrow tapered ribbons and individual tapered fibre triangles.
 for side in (-1,1):
  start=len(v);n={'high':20,'mid':12,'low':5}[lod]
  for i in range(n+1):
   t=i/n;x=side*(.15+.34*t);y=7.46+.055*math.sin(math.pi*t)-.026*t;z=1.46-.20*t
   width=.009+.014*math.sin(math.pi*t)
   for sign in (-1,1):v.append(brow_point(x,y+sign*width));parts.append(PARTS['brow'])
  for i in range(n):
   a=start+i*2;fs.extend([(a,a+2,a+1),(a+1,a+2,a+3)])if side>0 else fs.extend([(a,a+1,a+2),(a+1,a+3,a+2)])
  for i in range(n*2):
   t=(i+.5)/(n*2);x=side*(.15+.34*t);y=7.46+.055*math.sin(math.pi*t)-.026*t
   width=.009+.014*math.sin(math.pi*t);y+=.25*width*math.sin(i*2.1)
   base=len(v);v.extend([brow_point(x-.0018,y),brow_point(x+.0018,y),brow_point(x+side*.003,y+.013+.008*math.sin(math.pi*t))]);parts.extend([PARTS['brow']]*3);fs.append((base,base+1,base+2))
 positions=[world(p)for p in v];ns=normals(positions,fs)
 morphs=[[morph(p,parts[i],name)for i,p in enumerate(v)]for name in TARGETS]
 uv=[[.5+math.atan2(p[0],p[2]-.45)/(2*math.pi),(p[1]-5.68)/(8.50-5.68)]for p in v]
 binary=bytearray();views=[];access=[]
 def attr(data,typ,component=5126,bounds=False):
  binary.extend(b'\0'*((-len(binary))%4));offset=len(binary);flat=[x for row in data for x in row]if typ!='SCALAR'else data
  fmt='f'if component==5126 else 'H';payload=struct.pack('<'+fmt*len(flat),*flat);binary.extend(payload)
  views.append({'buffer':0,'byteOffset':offset,'byteLength':len(payload)})
  a={'bufferView':len(views)-1,'componentType':component,'count':len(data),'type':typ}
  if bounds:
   a['min']=[min(p[k]for p in data)for k in range(len(data[0]))];a['max']=[max(p[k]for p in data)for k in range(len(data[0]))]
  access.append(a);return len(access)-1
 iris_values=[iris_detail(p)if parts[i]==PARTS['iris']else 1. for i,p in enumerate(v)]
 palette=[[.58,.34,.25],[.39,.14,.13],[.50,.26,.21],[.89,.91,.86],[.16,.23,.13],[.015,.012,.01],[.045,.028,.018],[.06,.014,.012]]
 pa=attr(positions,'VEC3',bounds=True);na=attr(ns,'VEC3');ua=attr(uv,'VEC2');parta=attr(parts,'SCALAR');ca=attr([[x*iris_values[i]for x in palette[part]]for i,part in enumerate(parts)],'VEC3');irisa=attr(iris_values,'SCALAR');ia=attr([i for f in fs for i in f],'SCALAR',5123)
 targets=[]
 for m in morphs:
  target={'POSITION':attr(m,'VEC3',bounds=True)}
  if lod!='low':
   posed=[[positions[i][k]+m[i][k]for k in range(3)]for i in range(len(positions))];posed_normals=normals(posed,fs)
   target['NORMAL']=attr([[posed_normals[i][k]-ns[i][k]for k in range(3)]for i in range(len(positions))],'VEC3',bounds=True)
  targets.append(target)
 details={'lod':lod,'coordinateSpace':'world rest; metres; +Z forward; +Y up','headAnchor':[0,1.66,0], 'parts':PARTS,'targetNames':TARGETS,'sourceSurfaceVertices':surface_count,'morphRanges':{name:[0,1]for name in TARGETS},'eyeCenters':[world([-EYE[0],EYE[1],EYE[2]]),world(EYE)],'eyeRadius':EYE_RADIUS*.12,'irisRadius':.060*.12,'pupilRadius':.002,'irisDetail':'Original analytic radial colour and 0.02mm fibre relief; _IRIS multiplies runtime iris colour.','seamSlope':.10,'sourceTriangles':source_count,'decimation':decimation,'morphNormals':lod!='low','authoring':'Pinned CC0 source skin; original spherical cornea/iris, brow ribbons, fitted lid deformation and bounded expression/shape functions.'}
 if lod=='low':details.pop('morphNormals')
 j={'asset':{'version':'2.0','generator':'Original PlayQube Football head authoring v1','extras':{'sourceSHA256':SOURCE_SHA,'sourceCommit':COMMIT,'coreAssetLicense':'CC0-1.0'}},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0,'name':'Fictional anatomical player head '+lod}], 'meshes':[{'name':'PlayerHead-'+lod,'weights':[0.]*len(TARGETS),'extras':details,'primitives':[{'attributes':{'POSITION':pa,'NORMAL':na,'TEXCOORD_0':ua,'_PART':parta,'_IRIS':irisa,'COLOR_0':ca},'indices':ia,'targets':targets,'material':0}]}], 'materials':[{'name':'Neutral preview; runtime applies semantic PBR','pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':0,'roughnessFactor':.56},'doubleSided':False}], 'buffers':[{'byteLength':len(binary)}],'bufferViews':views,'accessors':access}
 binary.extend(b'\0'*((-len(binary))%4));js=json.dumps(j,separators=(',',':')).encode();js+=b' '*((-len(js))%4)
 out=struct.pack('<III',0x46546c67,2,28+len(js)+len(binary))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(binary),0x004e4942)+binary;
 if '--check' in sys.argv:
  if path.read_bytes()!=out:raise ValueError('Head export drift: '+path.name)
 else:path.write_bytes(out)
 return {'file':path.name,'sha256':hashlib.sha256(out).hexdigest(),'bytes':len(out),'vertices':len(v),'triangles':len(fs),'anatomicalSurfaceTriangles':surface_triangles,'bounds':{'min':access[pa]['min'],'max':access[pa]['max']},'semanticCounts':dict(collections.Counter(parts)),**details,'morphNormals':lod!='low'}

def main():
 ap=argparse.ArgumentParser();ap.add_argument('source',type=pathlib.Path);ap.add_argument('--check',action='store_true',help='Check generated GLB bytes without rewriting assets.');ap.add_argument('--reuse-current-lods',action='store_true',help='Rebuild original attachments/morphs using retained LOD facial surfaces; no decimator runs.');ap.add_argument('--output',type=pathlib.Path,default=pathlib.Path('apps/web/public/models/football'));args=ap.parse_args();args.output.mkdir(parents=True,exist_ok=True)
 license_file=pathlib.Path(__file__).resolve().parents[2]/'apps/web/public/models/football/LICENSE-CC0.txt'
 if hashlib.sha256(license_file.read_bytes()).hexdigest()!=LICENSE_SHA:raise ValueError('Retained license must match pinned source LICENSE.ASSETS.md')
 vertices,triangles,ids=read_obj(args.source);reports=[]
 # Anatomically fitted inner-lid loops are protected in mid LOD by pinned IDs
 # plus coordinates mirrored from the source, retaining source feature topology.
 loop=[vertices[ids.index(i)]for i in range(7747,7773)]
 protected=set(i for i,p in enumerate(vertices)if any(norm(sub(p,[side*q[0],q[1],q[2]]))<1e-5 for q in loop for side in(-1,1)))
 for lod,target in [('high',8672),('mid',3000),('low',550)]:
  print('authoring',lod,flush=True)
  if args.reuse_current_lods and lod!='high':
   previous=(args.output/('player-head-'+lod+'.glb')).read_bytes();jl=struct.unpack_from('<I',previous,12)[0];old=json.loads(previous[20:20+jl]);blob=previous[28+jl:];mesh=old['meshes'][0];prim=mesh['primitives'][0];extra=mesh['extras'];a=old['accessors'][prim['attributes']['POSITION']];view=old['bufferViews'][a['bufferView']];surface=extra['sourceSurfaceVertices'];vals=struct.unpack_from('<'+'f'*(surface*3),blob,view.get('byteOffset',0));v=[[vals[i*3]/.12,(vals[i*3+1]-1.5)/.12+5.89,vals[i*3+2]/.12+.161]for i in range(surface)];a=old['accessors'][prim['indices']];view=old['bufferViews'][a['bufferView']];count=extra['decimation']['achievedTriangles']*3;vals=struct.unpack_from('<'+'H'*count,blob,view.get('byteOffset',0));f=[tuple(vals[i:i+3])for i in range(0,count,3)];dec=extra['decimation']
  elif lod=='high':v=[p[:]for p in vertices];f=triangles[:];dec={'requestedTriangles':8672,'achievedTriangles':8672,'method':'source topology untouched'}
  else:v,f,dec=simplify(vertices,triangles,target,protected.copy()if lod=='mid'else set());dec['method']='original feature-weighted quadric collapse; normals/fold guard; mid inner-lid loops protected'
  report=export(args.output/('player-head-'+lod+'.glb'),v,f,lod,len(triangles),dec);reports.append(report);print(json.dumps({k:report[k]for k in ['file','bytes','vertices','triangles','anatomicalSurfaceTriangles','sha256']}),flush=True)
 metadata={'schemaVersion':1,'exportVersion':'original-football-head-v1','normalTargetLODs':['high','mid'],'exportSteps':['Verify pinned source base.obj and retained LICENSE-CC0.txt SHA-256.', 'Extract core body-group faces wholly above source Y=5.68; retain all high facial triangles.', 'Build mid/low with original feature-weighted quadric collapse and face-fold rejection; protect mid inner-lid loops.', 'Add original fitted spherical eye caps, iris/pupil discs and brow ribbons.', 'Generate bounded facial/identity POSITION morphs and posed NORMAL deltas for high/mid.', 'Write local glTF 2.0 GLB buffers with UVs, normals, semantic _PART and neutral preview COLOR_0.', 'Run independent source-topology, aperture, bounds, normal-target and manifest validation.'],'authoringScriptSHA256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'sources':[{'asset':'MakeHuman core base.obj','commit':COMMIT,'url':f'https://github.com/makehumancommunity/makehuman/blob/{COMMIT}/makehuman/data/3dobjs/base.obj','sha256':SOURCE_SHA,'license':'CC0-1.0','licenseSHA256':LICENSE_SHA,'retainedLicenseFile':'LICENSE-CC0.txt','licenseUrl':f'https://github.com/makehumancommunity/makehuman/blob/{COMMIT}/LICENSE.ASSETS.md','licenseVerification':'Core asset policy verified 2026-10-15 at https://static.makehumancommunity.org/about/license.html and https://static.makehumancommunity.org/mpfb/faq/use_in_closed_source.html; third-party assets excluded.'}], 'originalAdditions':['Fitted 2mm pupils, original iris radial colour/relief, 1.2mm raised brows and tapered brow fibre triangles','Eight fitted expression/shape targets authored with coordinate functions','UVs, vertex normals, semantic material IDs','Feature-priority LOD authoring and standalone GLB writer'], 'reproduce':'python3 scripts/assets/build-football-heads.py path/to/verified/base.obj --reuse-current-lods --check','lodSurfaceInput':'Mid/low attachment revisions use retained encoded facial surface prefixes from the delivered GLBs; cold full LOD authoring remains available without --reuse-current-lods.','authoringSoftware':'Python 3 standard library; original repository script. No Blender/MakeHuman/MPFB application source included.', 'runtimeDependencies':[], 'textures':[],'exports':reports,'limits':['Neutral generic core anatomy with original fictional variants; no scan or real player likeness.','PBR skin, strand hair/beards, lashes and kit cloth handled by runtime; no skin texture imported.','Mid preserves inner-lid loops; low is distant-only and cannot prove close-up facial quality.','Jaw morph is a restrained surface deformation; no dental/tongue or full lip-sync rig.','Rendered review and device acceptance remain separate from structural checks.']}
 if not args.check:(args.output/'player-head-provenance.json').write_text(json.dumps(metadata,indent=2)+'\n')
if __name__=='__main__':main()
