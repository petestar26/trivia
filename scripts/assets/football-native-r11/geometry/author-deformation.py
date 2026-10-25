"""R11 original numerical SOURCE authoring, not a human artist/DCC sculpt claim.
Creates editable neutral garment fit, explicit skinning bands and baked named
pose-space guide corrections. No runtime procedural correction is introduced.
Canonical49 rig/face/sole/root/actions remain unchanged. Native drivers are simple
quaternion-twist expressions; baseline sampled correction keys are muted.
"""
import bpy,bmesh,json,math,hashlib,array,sys,struct,importlib.util
from pathlib import Path
from mathutils import Vector,Matrix,Quaternion
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'verified-source';OUT=ROOT/'geometry'
DATA=json.loads((SRC/'bridge/assembled-niko-bind.json').read_text());C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)));CI=C.inverted();CQ=Quaternion((1,0,0),math.pi/2)
RIG=bpy.data.objects['Production49'];BONES=[b['name'] for b in DATA['rig']['bones']]
RECORD={'kind':'original numerical source garment/weight/pose-guide authoring','sourceBlendSHA256':'6a899f83bf3a8f26fa365ef1ad28acd074265fa0c5ea192ea502ea0f82a53e23','neutralEdits':{},'weightEdits':{},'correctives':[],'drivers':[],'limits':['No human artist authorship or finished realism claim','No source face/49rest/root/foot/ball/contact/clock changes','Old BASELINE_SAMPLED correction keys muted; do not stack old inverse-volume or garment fairing with authored source mode','New keys and drivers must remain separate from eight accepted face channels','73.156mm follow-through overlap remains open']}


def smooth(a,b,x):
 t=max(0,min(1,(x-a)/(b-a)));return t*t*(3-2*t)
def bone_rest():
 if RIG.animation_data:RIG.animation_data.action=None
 RIG.matrix_world=Matrix.Identity(4)
 for b in RIG.pose.bones:b.rotation_mode='QUATERNION';b.rotation_quaternion=(1,0,0,0);b.location=(0,0,0);b.scale=(1,1,1)
 bpy.context.view_layer.update()
def rot(name,axis,angle):
 q=CQ@Quaternion(axis,angle)@CQ.conjugated();RIG.pose.bones[name].rotation_quaternion=q
 bpy.context.view_layer.update()
def rest_positions(ob):return [CI@v.co for v in ob.data.shape_keys.key_blocks[0].data] if ob.data.shape_keys else [CI@v.co for v in ob.data.vertices]
def groups(ob):
 return [{ob.vertex_groups[g.group].name:g.weight for g in v.groups if g.weight>0} for v in ob.data.vertices]
def replace_weights(ob,changes):
 records=[]
 for i,w in changes.items():
  old={ob.vertex_groups[g.group].name:g.weight for g in ob.data.vertices[i].groups if g.weight>0}
  if max([abs(old.get(k,0)-w.get(k,0)) for k in set(old)|set(w)],default=0)<1e-7:continue
  # Freeze primitive groupindices BEFORE mutation. RNA elements shift after
  # removal; retaining live VertexGroupElement views leaves stale weights.
  for group_index in [g.group for g in ob.data.vertices[i].groups]:ob.vertex_groups[group_index].remove([i])
  for name,value in w.items():
   if value>1e-10:ob.vertex_groups[name].add([i],value,'REPLACE')
  actual={ob.vertex_groups[g.group].name:g.weight for g in ob.data.vertices[i].groups if g.weight>0}
  assert abs(sum(actual.values())-1)<1e-6,(ob.name,i,'actualsum',actual)
  assert max([abs(actual.get(k,0)-w.get(k,0)) for k in set(actual)|set(w)],default=0)<1e-6,(ob.name,i,'actualreadback',actual,w)
  records.append({'vertex':i,'before':old,'after':w,'nativeReadback':actual})
 RECORD['weightEdits'][ob.name]=records

def neutral_edit(ob,deltas):
 records=[]
 for i,delta in deltas.items():
  if delta.length<1e-9:continue
  native=C.to_3x3()@delta
  if ob.data.shape_keys:
   for key in ob.data.shape_keys.key_blocks:key.data[i].co+=native
  else:ob.data.vertices[i].co+=native
  records.append({'vertex':i,'deltaRuntimeMetres':list(delta)})
 RECORD['neutralEdits'][ob.name]=records;ob.data.update()

def source_mesh(name):return next(m for m in DATA['meshes'] if m['name']==name)
def restore_calf_visibility(ob):
 raw=SRC/'bridge/raw-runtime-sources/continuous-body.glb';blob=raw.read_bytes();n=struct.unpack_from('<I',blob,12)[0];g=json.loads(blob[20:20+n]);bin_offset=20+n+8;prim=g['meshes'][0]['primitives'][0];a=g['accessors'][prim['indices']];view=g['bufferViews'][a['bufferView']];fmt={5123:'H',5125:'I'}[a['componentType']];start=bin_offset+view.get('byteOffset',0)+a.get('byteOffset',0);ids=array.array(fmt);ids.frombytes(blob[start:start+a['count']*ids.itemsize])
 pos=rest_positions(ob);bm=bmesh.new();bm.from_mesh(ob.data);bm.verts.ensure_lookup_table();existing={tuple(sorted(v.index for v in f.verts)) for f in bm.faces};added=[]
 source=source_mesh(ob.name);uvs={}
 for name in ['uv','uv1']:
  av=source['attributes'][name];values=array.array('f');import base64;values.frombytes(base64.b64decode(av['dataBase64']));uvs[name]=(bm.loops.layers.uv.get(name),values)
 for k in range(0,len(ids),3):
  tri=list(ids[k:k+3]);ys=[pos[i].y for i in tri]
  if tuple(sorted(tri)) in existing or not (min(ys)>.415 and max(ys)>.441 and min(ys)<.478 and max(ys)<.52):continue
  face=bm.faces.new([bm.verts[i] for i in tri]);face.smooth=True
  for loop,index in zip(face.loops,tri):
   for name,(layer,values) in uvs.items():loop[layer].uv=values[index*2:index*2+2]
  added.append(tri)
 bm.to_mesh(ob.data);bm.free();ob.data.update()
 RECORD['visibleMaskEdit']={'addedTriangleRuntimeYBounds':[min(pos[i].y for tri in added for i in tri),max(pos[i].y for tri in added for i in tri)],'addedTriangleCount':len(added),'sourceRawBodySHA256':hashlib.sha256(blob).hexdigest(),'sameVertexCount':len(ob.data.vertices),'addedOriginalSourceTriangles':added,'reason':'Fitted posterior sockhem lowers to.456; restore same-source anatomical uppercalf band instead of leaving old.474render-mask gap. Existing head/shirt/short/footmask retained.','requiresNewRuntimeMaskManifest':True}

def bind_mix(ob,index):
 m=Matrix(((0,0,0,0),)*4)
 for g in ob.data.vertices[index].groups:
  name=ob.vertex_groups[g.group].name
  if name in RIG.pose.bones:
   b=RIG.pose.bones[name];m+=g.weight*(b.matrix@b.bone.matrix_local.inverted())
 return m

def add_shape_from_guide(ob,name,kind,side,angle,guide,bind_limit):
 basis=ob.data.shape_keys.key_blocks[0] if ob.data.shape_keys else ob.shape_key_add(name='Basis',from_mix=False)
 key=ob.shape_key_add(name=name,from_mix=False);deltas=[]
 for i,v in enumerate(basis.data):
  p=CI@v.co;target=guide(i,p)
  if target is None:key.data[i].co=v.co;continue
  mix=bind_mix(ob,i);posed=CI@(mix@v.co);desired=target(posed)
  delta=mix.inverted_safe()@(C@desired)-v.co
  if delta.length>bind_limit:delta*=bind_limit/delta.length
  key.data[i].co=v.co+delta
  if delta.length>1e-8:deltas.append({'vertex':i,'deltaNative':list(delta)})
 key.value=0;key.slider_min=0;key.slider_max=1
 RECORD['correctives'].append({'mesh':ob.name,'name':name,'kind':kind,'side':side,'angleRadians':angle,'source':'New explicit pose-guide correction; not copied from BASELINE_SAMPLED formula','bindDisplacementLimitMetres':bind_limit,'maximumBindDeltaMetres':max((Vector(v['deltaNative']).length for v in deltas),default=0),'deltas':deltas})
 return key

def driver(key,kind,side,peak,other):
 b=('upperArm' if kind=='shoulder' else 'lowerLeg')+side
 norm='max(1e-12,qw*qw+qx*qx+qy*qy+qz*qz)'
 if kind=='knee':
  angle=f'acos(max(-1,min(1,(qw*qw+qz*qz-qx*qx-qy*qy)/{norm})))';semantic='Normalized geometric thigh/shin flex angle; rest limb direction native−Z; ignores axial twist'
 else:
  sign=-1 if side=='L' else 1
  angle=f'asin(max(-1,min(1,{sign*2}*(qx*qz+qy*qw)/{norm})))';semantic='True lateral upperarm elevation in chest frame, range0..90degrees; pure forward flex remains0; homogeneous in quaternion norm'
 prop=('R11_KneeFlex_' if kind=='knee' else 'R11_ShoulderAbduction_')+side
 if prop not in RIG:
  RIG[prop]=0.0;f=RIG.driver_add('["'+prop+'"]');f.driver.type='SCRIPTED';f.driver.expression=angle
  for name,idx in [('qw',0),('qx',1),('qy',2),('qz',3)]:
   v=f.driver.variables.new();v.name=name;v.type='SINGLE_PROP';v.targets[0].id=RIG;v.targets[0].data_path=f'pose.bones["{b}"].rotation_quaternion[{idx}]'
  assert f.driver.is_simple_expression,(prop,angle)
  RECORD.setdefault('semanticDrivers',[]).append({'property':prop,'bone':b,'expression':angle,'semanticInput':semantic,'referenceVectorNative':[0,0,-1],'normalizedQuaternionInvariant':True})
 lo=math.radians(20 if kind=='shoulder' else 10);l=f'{lo:.8f}';pk=f'{peak:.8f}';ot=f'{other:.8f}'
 if peak<other:expr=f'max(0,min(1,(a-{l})/({pk}-{l})))*max(0,min(1,({ot}-a)/({ot}-{pk})))'
 else:expr=f'max(0,min(1,(a-{ot})/({pk}-{ot})))'
 f=key.driver_add('value');f.driver.type='SCRIPTED';f.driver.expression=expr;v=f.driver.variables.new();v.name='a';v.type='SINGLE_PROP';v.targets[0].id=RIG;v.targets[0].data_path='["'+prop+'"]'
 RECORD['drivers'].append({'key':key.name,'semanticProperty':prop,'bone':b,'expression':expr,'semanticInput':semantic,'referenceVectorNative':[0,0,-1],'sourceFrame':'canonical49 zero-rest-rotation parent frame','onsetRadians':lo,'peakRadians':peak,'adjacentPeakRadians':other,'ownership':'R11 native pose deformation; independent of face channels and clocks'})

# Never layer old sampled source formulas on top of the new source-mode controls.
for ob in bpy.data.objects:
 if ob.type=='MESH' and ob.name.startswith('niko-') and ob.data.shape_keys:
  for k in ob.data.shape_keys.key_blocks:
   if k.name.startswith('BASELINE_SAMPLED'):k.value=0;k.mute=True
  ob.data.shape_keys['R11_source_mode']='Authored neutral/weights/pose-guide source; legacy BASELINE_SAMPLED keys muted, no old generic formula stacking.'

bone_rest()
jersey=bpy.data.objects['niko-jersey'];p=rest_positions(jersey);meta=source_mesh('niko-jersey')['userData'];rows=meta['authoredCollarSource']['records'];column={}
for rec in rows:
 if rec['row']==0:column.setdefault(rec['column'],p[rec['vertex']].copy())
new_controls={};offsets={}
for col,v in column.items():
 theta=math.atan2((v.z-.006)/.067,v.x/.075)
 z=.006+.067*math.sin(theta);x=.075*math.cos(theta);y=1.494-.034*smooth(-.01,.074,z)
 target=Vector((x,y,z));new_controls[col]=list(target);offsets[col]=target-v
change={}
for rec in rows:
 i=rec['vertex'];w=(1-rec['row']/10)**2
 change[i]=offsets[rec['column']]*w
for rec in meta['garmentTailoring']['derived']:
 change[rec['vertex']]=sum((change.get(j,Vector())*w for j,w in zip(rec['positionSourceVertices'],rec['positionCoefficients'])),Vector())
neutral_edit(jersey,change);RECORD['collarOpeningControlsRuntimeMetres']=new_controls
p=rest_positions(jersey);old=groups(jersey);wc={}
# Original source garment reweighting: ribcage/front panel must not inherit arm
# twist. Crown above the fixed shoulder joint follows clavicle/chest; sleeve
# movement enters through a broad below-joint transition and the actual cuff.
for i,v in enumerate(p):
 side='L' if v.x>0 else 'R';arm='upperArm'+side
 arm_source=sum(w for n,w in old[i].items() if n in [arm,'foreArm'+side])
 if v.y>=1.20:torso={'chest':1.0}
 elif v.y>=1.05:
  w=smooth(1.05,1.20,v.y);torso={'spine':1-w,'chest':w}
 else:
  w=smooth(.95,1.05,v.y);torso={'hips':1-w,'spine':w}
 lateral=smooth(.115,.19,abs(v.x))
 membership=lateral*max(arm_source,smooth(.16,.26,abs(v.x)))
 vertical=1-smooth(1.29,1.445,v.y)
 # No arm heuristic may reach the low torso/hem. Genuine cuffsource loop
 # overrides below preserve sleeve membership independently of this Y gate.
 arm_weight=membership*vertical*smooth(1.24,1.34,v.y)
 # Cuff is below the shoulder transition and genuinely follows upperarm.
 if v.y<1.30 and abs(v.x)>.125 and arm_source>.75:arm_weight=1.0
 # Entire medial upper panel stays on ribcage, preventing breast crescent fold.
 if abs(v.x)<.17 and v.y>1.20:arm_weight=0.0
 wc[i]={n:w*(1-arm_weight) for n,w in torso.items()}
 if arm_weight>0:wc[i][arm]=arm_weight
# Explicit source cuff loops, including UVduplicates/derivedreturns, must not
# be accidentally caught by the medial chest mask. Two adjacent rings blend.
cuff=set()
for rec in meta['garmentTailoring']['derived']:
 if p[rec['vertex']].y<1.35 and abs(p[rec['vertex']].x)>.12:
  cuff.add(rec['vertex']);cuff.update(rec['positionSourceVertices']);cuff.update(rec['linearUVWeightSourceVertices'])
positions_by_key={}
for i,v in enumerate(p):positions_by_key.setdefault(tuple(round(c,6) for c in v),[]).append(i)
for i in list(cuff):cuff.update(positions_by_key[tuple(round(c,6) for c in p[i])])
adj=[set() for _ in p]
for face in jersey.data.polygons:
 for i in face.vertices:adj[i].update(face.vertices)
frontier=set(cuff);visited=set(cuff)
for depth,strength in [(1,.70),(2,.40)]:
 ring={j for i in frontier for j in adj[i]}-visited
 for i in ring:
  if p[i].y>1.39 or abs(p[i].x)<.13:continue
  side='L' if p[i].x>0 else 'R';arm='upperArm'+side
  amount=max(wc[i].get(arm,0),strength);wc[i]={'chest':1-amount,arm:amount}
 visited.update(ring);frontier=ring
for i in cuff:wc[i]={'upperArm'+('L' if p[i].x>0 else 'R'):1.0}
# All eleven collar rings stay on chest; they are disjoint from true cuff loops.
for rec in rows:wc[rec['vertex']]={'chest':1.0}
RECORD['jerseyWeightControls']={'forbiddenBones':['neck','head'],'allShirtVerticesReauthored':True,'torsoBandsY':[.95,1.05,1.20],'medialChestAnchor':{'absXLessThan':.17,'yGreaterThan':1.20},'crownArmFadeY':[1.29,1.445],'armHeuristicYGate':[1.24,1.34],'explicitCuffVertices':sorted(cuff),'cuffAdjacentRings':[.70,.40],'lateralSleeveMembershipX':[.115,.19],'collarRowsChestBound':[0,10],'legacyFullArmAboveJointBranchRemoved':True}
# Derived collar/cuff weights follow their recorded source vertex interpolation.
for rec in meta['garmentTailoring']['derived']:
 if any(j in wc for j in rec['linearUVWeightSourceVertices']):
  mix={}
  for j,w in zip(rec['linearUVWeightSourceVertices'],rec['linearUVWeightCoefficients']):
   for n,m in wc.get(j,old[j]).items():mix[n]=mix.get(n,0)+w*m
  wc[rec['vertex']]=mix
replace_weights(jersey,wc)

# New source-fitted cuff/calf topology, including the actual lateral muscle
# peak ring. Original ankle/foot rows are explicitly copied and mapped.
socks=bpy.data.objects['niko-socks'];body=bpy.data.objects['niko-body']
spec=importlib.util.spec_from_file_location('sock_source_authoring',str(OUT/'sock-source-authoring.py'));sock_author=importlib.util.module_from_spec(spec);spec.loader.exec_module(sock_author)
sock_positions,sock_body_triangles=sock_author.build_source(socks,body,SRC/'bridge/raw-runtime-sources/continuous-body.glb',RECORD,replace_weights)

# Explicit production-space knee weight bands, shared across UV-equivalent
# corners, separate from the new pose guide shape. No head/ankle weights change.
body=bpy.data.objects['niko-body'];restore_calf_visibility(body);p=rest_positions(body);old=groups(body);wc={}
bands=[(.405,1),(.44,.94),(.47,.72),(.50,.44),(.53,.22),(.56,.07),(.595,0)]
for i,v in enumerate(p):
 side='L' if v.x>0 else 'R';up='upperLeg'+side;low='lowerLeg'+side
 if not (.405<v.y<.595) or old[i].get(up,0)+old[i].get(low,0)<.97:continue
 for (a,wa),(b,wb) in zip(bands,bands[1:]):
  if a<=v.y<=b:w=wa+(wb-wa)*smooth(a,b,v.y);break
 # Anterior patella follows the femur more than posterior skin; explicit
 # surface-conditioned source bands preserve that anatomical distinction.
 w=max(0,min(1,w-.14*smooth(.005,.06,v.z)*(1-min(1,abs(v.y-.5)/.095)**2)))
 wc[i]={up:1-w,low:w}
replace_weights(body,wc);RECORD['kneeWeightBandControls']={'heightBands':[list(x) for x in bands],'anteriorFemurBias':.14,'biasFrontZBand':[.005,.06],'axialFadeCentreY':.5,'axialFadeRadius':.095}

# Pose-space source targets are baked in bind space and remain editable keys.
for side,sign in [('L',1),('R',-1)]:
 for degrees in [45,90]:
  a=math.radians(degrees);bone_rest();rot('upperArm'+side,(0,0,1),sign*a)
  def guide(i,v,a=a,side=side,sign=sign):
   if sign*v.x<.095 or sign*v.x>.31 or not (1.27<v.y<1.495):return None
   wside=math.sin(math.pi*max(0,min(1,(sign*v.x-.095)/.215)))
   top=smooth(1.305,1.405,v.y);front=.7+.3*smooth(-.10,.08,v.z)
   amount=(.010 if degrees==45 else .022)*wside*top*front
   def target(q):return q+Vector((0,amount,0))
   return target
  key=add_shape_from_guide(jersey,f'R11_ShoulderCrown_{side}_{degrees}','shoulder',side,a,guide,.030)
  driver(key,'shoulder',side,a,math.radians(90 if degrees==45 else 45))
 for degrees in [60,120]:
  a=math.radians(degrees);bone_rest();rot('lowerLeg'+side,(1,0,0),a)
  n=Vector((0,-math.sin(a/2),math.cos(a/2)));pivot=Vector((sign*.1,.5,0))
  def guide(i,v,a=a,n=n,pivot=pivot,side=side):
   if not (.405<v.y<.595) or abs(v.x-pivot.x)>.09:return None
   g=groups_cache[i]
   if g.get('upperLeg'+side,0)+g.get('lowerLeg'+side,0)<.97:return None
   axial=(1-min(1,abs(v.y-.5)/.095)**2)**2;lateral=1-min(1,abs(v.x-pivot.x)/.09)**2
   anterior=smooth(-.005,.05,v.z);posterior=smooth(.025,.075,-v.z)
   def target(q):
    # Patella guide retains a deliberate convex anterior envelope; posterior
    # fold receives restrained compression instead of inverse-volume inflation.
    radial=(q-pivot).dot(n);wanted=v.z*.96
    extension=max(0,min(.018,wanted-radial))*anterior*axial*lateral
    compress=.004*posterior*axial*lateral*(a/math.radians(120))
    return q+n*(extension+compress)
   return target
  groups_cache=groups(body)
  key=add_shape_from_guide(body,f'R11_PatellaFold_{side}_{degrees}','knee',side,a,guide,.032)
  driver(key,'knee',side,a,math.radians(120 if degrees==60 else 60))

# New garment pose-space shapes follow their exact neutral body triangle/bary
# correspondence, avoiding a nearest-surface jump to the opposing thigh.
sock_author.build_pose_keys(socks,body,RIG,sock_positions,sock_body_triangles,RECORD,bone_rest,rot,bind_mix,driver)

# Keep source controls inspectable as a hidden, nonrendering original guide set.
col=bpy.data.collections.new('R11_NUMERICAL_SOURCE_GUIDES');bpy.context.scene.collection.children.link(col);col.hide_render=True;col.hide_viewport=True
for i,p in new_controls.items():
 ob=bpy.data.objects.new('R11_CollarControl_'+str(i).zfill(2),None);col.objects.link(ob);ob.location=C@Vector(p);ob.empty_display_type='SPHERE';ob.empty_display_size=.002
for side,s in [('L',1),('R',-1)]:
 ob=bpy.data.objects.new('R11_PatellaEnvelope_'+side,None);col.objects.link(ob);ob.location=C@Vector((s*.1,.5,.055));ob.empty_display_type='SPHERE';ob.empty_display_size=.055
body.data.shape_keys['R11_new_corrective_ownership']='R11_PatellaFold* native drivers. Do not zero these when copying the eight known facial targets.'
jersey.data.shape_keys['R11_new_corrective_ownership']='R11_ShoulderCrown* native drivers. Old BASELINE_SAMPLED keys muted.'
RECORD['sourceMode']='R11_AUTHORED_SOURCE; no old formula/sample stacking'
RECORD['bodyMask']='Source vertex count/IDs unchanged. Exact listed uppercalf triangles restored after hem tailoring; new source SHA+mask index manifest required before runtime use.'
(OUT/'deformation-authoring-source.json').write_text(json.dumps(RECORD,indent=2)+'\n')
# Simple expression drivers remain active with --disable-autoexec.
for ob in [body,jersey]:
 for f in ob.data.shape_keys.animation_data.drivers:assert f.driver.is_simple_expression,(ob.name,f.data_path)
# Restore accepted fixed identity/rest. No source actions are edited or active.
bone_rest();pose=DATA['poseVariants']['acceptedRest']
for b in pose['bones']:
 p=RIG.pose.bones[b['name']];q=b['localQuaternion'];p.rotation_quaternion=CQ@Quaternion((q[3],q[0],q[1],q[2]))@CQ.conjugated()
bpy.context.view_layer.update()
RIG['R11_DeformationSource']='Original numerical neutral fit/weights/pose-guide shapes. Existing sampled keys muted; no human artist claim. 49rig/root/contact/face/actions retained.'
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'Player_Deformation.blend'),compress=True)
print(json.dumps({'output':str(OUT/'Player_Deformation.blend'),'neutralEdits':{k:len(v) for k,v in RECORD['neutralEdits'].items()},'weightEdits':{k:len(v) for k,v in RECORD['weightEdits'].items()},'correctives':[(x['name'],len(x['deltas']),x['maximumBindDeltaMetres']) for x in RECORD['correctives']]}))
