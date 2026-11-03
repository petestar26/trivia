"""Independent structural/anatomical probes for exported head GLBs; stdlib only.
Usage: python3 scripts/assets/validate-football-heads.py path/to/pinned/base.obj
"""
import collections,hashlib,json,math,pathlib,struct,sys
HERE=pathlib.Path(__file__).resolve().parents[2];ASSETS=HERE/'apps/web/public/models/football'
def read_glb(p):
 raw=p.read_bytes();magic,version,length=struct.unpack_from('<III',raw);assert magic==0x46546c67 and version==2 and length==len(raw)
 jl,jt=struct.unpack_from('<II',raw,12);assert jt==0x4e4f534a
 j=json.loads(raw[20:20+jl]);bl,bt=struct.unpack_from('<II',raw,20+jl);assert bt==0x004e4942 and bl==len(raw)-28-jl
 return j,raw[28+jl:]
def attribute(j,b,index):
 a=j['accessors'][index];v=j['bufferViews'][a['bufferView']];size={'SCALAR':1,'VEC2':2,'VEC3':3}[a['type']];fmt={5126:'f',5123:'H'}[a['componentType']];n=a['count']*size;offset=v.get('byteOffset',0)+a.get('byteOffset',0)
 data=struct.unpack_from('<'+fmt*n,b,offset);return [data[i:i+size]for i in range(0,n,size)]
# Read the exact source surface independently of exporter.
v=[];f=[];group=''
raw=pathlib.Path(sys.argv[1]).read_bytes();assert hashlib.sha256(raw).hexdigest()=='8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c'
for l in raw.decode().splitlines():
 a=l.split()
 if not a:continue
 if a[0]=='v':v.append(list(map(float,a[1:4])))
 elif a[0]=='g':group=a[1]
 elif a[0]=='f'and group=='body':
  ids=[int(s.split('/')[0])-1 for s in a[1:]]
  if all(v[i][1]>5.68 for i in ids):
   for k in range(1,len(ids)-1):f.append((ids[0],ids[k],ids[k+1]))
used=sorted(set(i for tri in f for i in tri));source_map={s:i for i,s in enumerate(used)}
manifest=json.loads((ASSETS/'player-head-provenance.json').read_text());assert len(manifest['sources'])==1
assert manifest['authoringScriptSHA256']==hashlib.sha256((HERE/'scripts/assets/build-football-heads.py').read_bytes()).hexdigest()
assert manifest['sources'][0]['sha256']==hashlib.sha256(raw).hexdigest()
assert manifest['sources'][0]['licenseSHA256']==hashlib.sha256((ASSETS/manifest['sources'][0]['retainedLicenseFile']).read_bytes()).hexdigest()=='f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c'
reports=[]
for lod in ['high','mid','low']:
 p=ASSETS/('player-head-'+lod+'.glb');j,b=read_glb(p);mesh=j['meshes'][0];prim=mesh['primitives'][0];attrs={k:attribute(j,b,a)for k,a in prim['attributes'].items()};pos=attrs['POSITION'];parts=[a[0]for a in attrs['_PART']];idx=[a[0]for a in attribute(j,b,prim['indices'])];targets={name:attribute(j,b,prim['targets'][k]['POSITION'])for k,name in enumerate(mesh['extras']['targetNames'])}
 recorded=next(r for r in manifest['exports']if r['lod']==lod)
 assert recorded['sha256']==hashlib.sha256(p.read_bytes()).hexdigest()and recorded['bytes']==p.stat().st_size
 assert recorded['vertices']==len(pos)and recorded['triangles']==len(idx)//3
 assert recorded['morphNormals']==(lod!='low')
 assert mesh['extras']['targetNames']==['blinkLeft','blinkRight','jawOpen','browRaise','smile','noseWidth','lipFullness','earSize']
 for view in j['bufferViews']:
  assert view.get('byteOffset',0)%4==0 and view.get('byteOffset',0)+view['byteLength']<=len(b)
 for k in range(3):
  assert abs(min(row[k]for row in pos)-recorded['bounds']['min'][k])<2e-7
  assert abs(max(row[k]for row in pos)-recorded['bounds']['max'][k])<2e-7
 assert all(len(a)==len(pos)for a in attrs.values());assert max(idx)<len(pos)and len(idx)%3==0
 assert len(mesh['weights'])==len(targets)==8 and not any(mesh['weights'])
 assert all(math.isfinite(x)for a in attrs.values()for row in a for x in row)
 normal_surface_error=0.
 if lod in ['high','mid']:
  for target in prim['targets']:
   assert 'NORMAL'in target;delta=attribute(j,b,target['NORMAL']);assert len(delta)==len(pos)
   assert all(math.isfinite(x)for row in delta for x in row)
   lengths=[math.sqrt(sum((attrs['NORMAL'][i][k]+row[k])**2 for k in range(3)))for i,row in enumerate(delta)]
   assert all(.9999<n<1.0001 for n in lengths)
   # Check actual posed surface orientation, not only normal-vector length.
   delta_pos=attribute(j,b,target['POSITION']);posed=[[pos[i][k]+delta_pos[i][k]for k in range(3)]for i in range(len(pos))];acc=[[0.,0.,0.]for _ in pos]
   for offset in range(0,len(idx),3):
    ia,ib,ic=idx[offset:offset+3];a,c,d=posed[ia],posed[ib],posed[ic];u=[c[k]-a[k]for k in range(3)];w=[d[k]-a[k]for k in range(3)];area=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]]
    for vertex in [ia,ib,ic]:
     for k in range(3):acc[vertex][k]+=area[k]
   for i,area in enumerate(acc):
    length=math.sqrt(sum(x*x for x in area))
    if length>1e-14:
     err=max(abs(area[k]/length-attrs['NORMAL'][i][k]-delta[i][k])for k in range(3))
     normal_surface_error=max(normal_surface_error,err)
     # Float32 position cancellation at a fully closed crease permits ~0.1 degrees.
     assert err<.002

  assert any(abs(x)>.02 for row in attribute(j,b,prim['targets'][0]['NORMAL'])for x in row)
 assert all(len(t)==len(pos)for t in targets.values())
 assert all(math.isfinite(x)for t in targets.values()for row in t for x in row)
 nlen=[math.sqrt(sum(x*x for x in a))for a in attrs['NORMAL']];assert all(.9999<n<1.0001 for n in nlen)
 # Cornea, pupil and iris stay fixed through blinks and expressions. No eye scaling.
 ocular=[i for i,part in enumerate(parts)if part in [3,4,5]]
 assert all(all(abs(x)<1e-9 for x in target[i])for target in targets.values()for i in ocular)
 # Small original expression/variant deformations stay bounded in metres.
 maxmotion={name:max(math.sqrt(sum(x*x for x in row))for row in t)for name,t in targets.items()};assert all(d<=.031 for d in maxmotion.values())
 assert all(maxmotion[name]>.001 for name in targets)
 assert set(parts)>=set(range(7))
 assert mesh['extras']['pupilRadius']==.002 and '_IRIS'in attrs
 iris=[attrs['_IRIS'][i][0]for i,part in enumerate(parts)if part==4];assert max(iris)-min(iris)>.2
 for side in [-1,1]:
  pupil=[i for i,part in enumerate(parts)if part==5 and pos[i][0]*side>0];radius=max(math.hypot(pos[i][0]-side*.30775*.12,pos[i][1]-(1.5+(7.28415-5.89)*.12))for i in pupil);assert abs(radius-.002)<2e-7
 if lod=='high':
  # High retains every source vertex and triangle; no close-up face decimation.
  for i,source in enumerate(used):
   x,y,z=v[source];expected=[x*.12,1.5+(y-5.89)*.12,(z-.161)*.12];assert max(abs(pos[i][k]-expected[k])for k in range(3))<2e-7
  remap={s:i for i,s in enumerate(used)};assert idx[:len(f)*3]==[remap[i]for tri in f for i in tri]
 if lod in ['high','mid']:
  eyelids=[]
  for side,name in [(1,'blinkLeft'),(-1,'blinkRight')]:
   ids=[]
   for source in range(7747,7773):
    x,y,z=v[source];expected=[side*x*.12,1.5+(y-5.89)*.12,(z-.161)*.12];closest=min(range(mesh['extras']['sourceSurfaceVertices']),key=lambda i:sum((pos[i][k]-expected[k])**2 for k in range(3)));assert max(abs(pos[closest][k]-expected[k])for k in range(3))<2e-7;ids.append(closest)
   neutral=[];closed=[]
   for i in ids:
    x,y,z=pos[i];neutral.append(y-(1.5+(7.28415-5.89)*.12)-.10*(side*x-.30775*.12));dx,dy,dz=targets[name][i];closed.append(y+dy-(1.5+(7.28415-5.89)*.12)-.10*(side*(x+dx)-.30775*.12))
   neutral_aperture=max(neutral)-min(neutral);closed_aperture=max(closed)-min(closed)
   assert neutral_aperture>.009 and closed_aperture<.00005,(name,neutral_aperture,closed_aperture)
   eye_front=max(pos[i][2]for i in ocular);center_lids=[i for i in ids if abs(abs(pos[i][0])-.30775*.12)<.006];assert min(pos[i][2]+targets[name][i][2]for i in center_lids)>=eye_front-.001
   eyelids.append({'target':name,'neutralApertureMetres':neutral_aperture,'closedApertureMetres':closed_aperture,'closureRatio':1-closed_aperture/neutral_aperture})
 else:eyelids=[]
 reports.append({'lod':lod,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'vertices':len(pos),'triangles':len(idx)//3,'maxMorphDisplacementMetres':maxmotion,'eyelidClosure':eyelids,'maxPosedNormalComponentError':normal_surface_error,'posedNormalComponentTolerance':.002,'passes':['current manifest source and license hashes','current authoring script and exported GLB hashes','declared geometry counts and bounds','hard 2mm pupils and original varied iris intensity','aligned in-bounds buffer views','valid GLB buffers and finite attributes','indexed geometry bounds','unit normals','eight nonzero bounded morphs','fixed ocular geometry during morphs','normal deltas reconstruct unit normals matching actual posed surfaces'if lod!='low'else 'low distant-only rest normals','semantic skin/lip/socket/eye/iris/pupil/brow groups']+(['exact original high source topology']if lod=='high'else [])+(['both original lid apertures close to less than 0.05mm','neutral eye front stays within anatomical lid closure']if lod in ['high','mid']else [])})
print(json.dumps({'status':'PASS','reports':reports,'limitations':['These probes check structure, source preservation and coordinate-level closure; rendered deformation quality still requires prototype capture.','Not a performance, physical device, hair, scanned likeness or animation-quality acceptance.']},indent=2))
