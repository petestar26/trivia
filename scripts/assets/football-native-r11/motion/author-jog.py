"""R11: actual CC0 jog rest-frame retarget + original contact/weight-transfer fit.
No runtime source, original Blend, root authority or published clocks are changed.
"""
import bpy,json,math,hashlib,importlib.util,argparse,sys
from pathlib import Path
from mathutils import Matrix,Vector,Quaternion
P=Path(__file__).resolve().parent;BASE=P.parent/'verified-source'
ap=argparse.ArgumentParser();ap.add_argument('--check',action='store_true');ap.add_argument('--output',type=Path);ap.add_argument('--workdir',type=Path);ap.add_argument('--fit',type=Path);opts=ap.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []);WORK=opts.workdir or (P/'reauthor-check' if opts.check else P);WORK.mkdir(parents=True,exist_ok=True);OUT=opts.output or WORK/'Player_Jog.blend'
C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)));CQ=C.to_quaternion();CI=C.inverted();FWD=Vector((0,-1,0))
assert hashlib.sha256(Path(bpy.data.filepath).read_bytes()).hexdigest()=='6a899f83bf3a8f26fa365ef1ad28acd074265fa0c5ea192ea502ea0f82a53e23','Open the verified immutable R10 baseline before authoring'
assert hashlib.sha256((P/'baseline-contact-samples.json').read_bytes()).hexdigest()=='6a015686e408c78dd5f99ef4b9635ee0fc8659fd52defd85bf35957e4fc21ab4','Frozen baseline contact samples changed; do not move targets to fit the asset'
fit_path=opts.fit or P/'jog-authoring-fit.json';fit=json.loads(fit_path.read_text());controls=json.loads((P/'baseline-contact-samples.json').read_text());N=controls['divisions'];speed=controls['speed'];stride=controls['stride'];cadence=controls['cadence'];period=1/cadence;fps=30;period_frames=period*fps
rig=bpy.data.objects['Production49'];source=next(o for o in bpy.data.objects if o.type=='ARMATURE' and len(o.data.bones)==65)
source_action=next(a for a in bpy.data.actions if a.get('sourceOriginalActionName')=='Jog_Fwd_Loop')
names=list(rig.data.bones.keys());contract=json.loads((BASE/'reference-clip-contact-manifest.json').read_text());names=contract['rig']['boneOrder'];rest=contract['rig']['restBones']
original_rest={n:[v for row in rig.data.bones[n].matrix_local for v in row] for n in names}

def p(v):return Vector((v[0],-v[2],v[1]))
def q(v):return CQ@Quaternion((v[3],v[0],v[1],v[2]))@CQ.conjugated()
def runtime_point(v):return [v.x,v.z,-v.y]
def runtime_direction(v):
 values=runtime_point(v);length=math.sqrt(sum(x*x for x in values));return [x/length for x in values]
def runtime_q(v):
 v=CQ.conjugated()@v@CQ;values=[v.x,v.y,v.z,v.w];length=math.sqrt(sum(x*x for x in values));return [x/length for x in values]
def frame(direction,forward=FWD):
 y=Vector(direction).normalized();z=Vector(forward)-y*y.dot(forward)
 if z.length<1e-6:z=Vector((1,0,0))-y*y.x
 z.normalize();x=y.cross(z).normalized();return Matrix((x,y,z)).transposed().to_quaternion()
def source_rest_point(n):return source.matrix_world@source.data.bones[n].head_local

def target_direction(n):
 chain={'hips':'spine','spine':'chest','chest':'neck','neck':'head','upperArmL':'foreArmL','foreArmL':'handL','upperArmR':'foreArmR','foreArmR':'handR','handL':'middle1L','handR':'middle1R','upperLegL':'lowerLegL','lowerLegL':'footL','footL':'toeL','upperLegR':'lowerLegR','lowerLegR':'footR','footR':'toeR'}
 if n in chain:return p(rest[chain[n]]['worldMetres'])-p(rest[n]['worldMetres'])
 if n=='head':return Vector((0,0,1))
 if n.startswith(('thumb','index','middle','ring','pinky')):
  digit=n[:-2];j=int(n[-2]);side=n[-1];nxt=digit+str(j+1)+side
  return p(rest[nxt]['worldMetres'])-p(rest[n]['worldMetres']) if j<3 else p(rest[n]['worldMetres'])-p(rest[digit+'2'+side]['worldMetres'])
 return Vector((0,-1,0))
MAP={'hips':('pelvis','spine_01'),'spine':('spine_02','spine_03'),'chest':('spine_03','neck_01'),'neck':('neck_01','Head'),'head':('Head',None)}
for s,ls in [('L','l'),('R','r')]:
 for t,a,b in [('upperArm','upperarm','lowerarm'),('foreArm','lowerarm','hand'),('hand','hand','middle_01'),('upperLeg','thigh','calf'),('lowerLeg','calf','foot'),('foot','foot','ball'),('toe','ball','ball_leaf')]:MAP[t+s]=(a+'_'+ls,b+'_'+ls)
 for finger in ['thumb','index','middle','ring','pinky']:
  for j in [1,2,3]:MAP[finger+str(j)+s]=(f'{finger}_0{j}_{ls}',f'{finger}_0{j+1}_'+('leaf_' if j==3 else '')+ls)
T0={n:frame(target_direction(n)) for n in names}
S0={};S_REST={}
for n,(sn,child) in MAP.items():
 sr=source.matrix_world@source.data.bones[sn].matrix_local;S_REST[n]=sr.to_quaternion()
 direction=source_rest_point(child)-source_rest_point(sn) if child else Vector((0,0,1))
 S0[n]=frame(direction)
# An explicit anatomical calibration maps target DOWN arms to source T-pose arms.
# Source-rest delta alone would wrongly apply T-to-run rotation to an already-down arm.
calibration={n:S0[n]@T0[n].conjugated() for n in names}

source.animation_data_create();source.animation_data.action=source_action
for c in source.users_collection:c.hide_viewport=False
source.hide_viewport=False
# Preserve source pose/flow; reduce its stylized ~22cm pelvis bounce to a fit range.
raw=[]
for i in range(N+1):
 phase=i/N;sp=(phase+fit['sourcePhaseOffset'])%1;f=source_action.frame_range[0]+sp*(source_action.frame_range[1]-source_action.frame_range[0]);bpy.context.scene.frame_set(math.floor(f),subframe=f%1);bpy.context.view_layer.update()
 sq={n:(source.matrix_world@source.pose.bones[sn].matrix).to_quaternion()@S_REST[n].conjugated()@calibration[n] for n,(sn,_) in MAP.items()}
 poles={}
 for side,ls in [('L','l'),('R','r')]:
  h=source.matrix_world@source.pose.bones['thigh_'+ls].head;k=source.matrix_world@source.pose.bones['calf_'+ls].head;a=source.matrix_world@source.pose.bones['foot_'+ls].head
  u=(a-h).normalized();v=k-h;v-=u*v.dot(u);poles[side]=v.normalized() if v.length>1e-6 else FWD.copy()
 raw.append({'sourcePhase':sp,'rotations':sq,'pelvis':source.matrix_world@source.pose.bones['pelvis'].head,'poles':poles})
for r in raw:r['originalRetargetedWorldChest']=r['rotations']['chest'].copy()
# Deliberately calibrate generic sprintlike torso lean for the slower supported jog.
for n,definition in fit['globalTorsoPitchDegrees'].items():
    mean=sum(r['rotations'][n].to_euler('XYZ').x for r in raw[:-1])/N
    for r in raw:
        angles=r['rotations'][n].to_euler('XYZ')
        angles.x=math.radians(definition['mean'])+(angles.x-mean)*definition['variationGain']
        r['rotations'][n]=angles.to_quaternion().normalized()
# Restrain global source generic roll/yaw before transporting the complete arm subtree.
for n,definition in fit.get('globalTorsoRollYawDegrees',{}).items():
    original=[r['rotations'][n].to_euler('XYZ') for r in raw]
    mean_y=sum(e.y for e in original[:-1])/N;mean_z=sum(e.z for e in original[:-1])/N
    for r,angles in zip(raw,original):
        angles.y=max(-math.radians(definition['rollCap']),min(math.radians(definition['rollCap']),(angles.y-mean_y)*definition['rollGain']))
        angles.z=max(-math.radians(definition['yawCap']),min(math.radians(definition['yawCap']),(angles.z-mean_z)*definition['yawGain']))
        r['rotations'][n]=angles.to_quaternion().normalized()
if fit.get('transportUpperBodyRelativeToChest',False):
    for r in raw:
        transport=r['rotations']['chest']@r['originalRetargetedWorldChest'].conjugated()
        for n in names:
            if n.startswith(('upperArm','foreArm','hand','thumb','index','middle','ring','pinky')):
                r['rotations'][n]=(transport@r['rotations'][n]).normalized()
# Original compact arm carriage fit in the newly calibrated chest frame.
for r in raw:
 chest=r['rotations']['chest']
 for n in ['upperArmL','upperArmR']:
  original=r['rotations'][n];direction=original@target_direction(n).normalized();local=chest.conjugated()@direction;local.x*=fit['upperArmLateralScale'];local.normalize();new=chest@local;r['rotations'][n]=(direction.rotation_difference(new)@original).normalized()
source.animation_data.action=None
for c in source.users_collection:c.hide_viewport=True
source.hide_viewport=True
mean_source=sum(x['pelvis'].z for x in raw[:-1])/N
mean_base=sum(x['hips']['position'][1] for x in controls['samples'][:-1])/N
rig.animation_data_clear();rig.matrix_world=Matrix.Identity(4)
for ob in bpy.data.objects:
 if ob.type=='MESH' and ob.data.shape_keys:
  for key in ob.data.shape_keys.key_blocks:
   if key.name.startswith('BASELINE_SAMPLED'):key.value=0

def set_world(n,rotation):
 pb=rig.pose.bones[n];parent=pb.parent.matrix.to_quaternion().normalized() if pb.parent else Quaternion((1,0,0,0));pb.rotation_mode='QUATERNION';pb.rotation_quaternion=(parent.conjugated()@rotation.normalized()).normalized()
 bpy.context.view_layer.update()
def solve_leg(side,ankle,pole,foot_rotation):
 un='upperLeg'+side;ln='lowerLeg'+side;fn='foot'+side;h=rig.pose.bones[un].head.copy();v=ankle-h;d=v.length;u=v.normalized();reach=.43+.42
 assert d<reach-1e-5,('unreachable',side,d)
 a=(.43**2-.42**2+d*d)/(2*d);height=math.sqrt(max(0,.43**2-a*a));v=Vector(pole)-u*u.dot(pole)
 if v.length<1e-7:v=FWD-u*u.dot(FWD)
 v.normalize();k=h+u*a+v*height
 set_world(un,frame(k-h,v)@T0[un].conjugated());set_world(ln,frame(ankle-k,v)@T0[ln].conjugated());set_world(fn,foot_rotation)
 rig.pose.bones['toe'+side].rotation_quaternion=(1,0,0,0);bpy.context.view_layer.update()
 return k

def pose_baseline(sample):
 for b in sample['baselinePose']:
  n=b['name'];pb=rig.pose.bones[n];pb.location=p([b['localPosition'][j]-rest[n]['localMetres'][j] for j in range(3)]);pb.rotation_mode='QUATERNION';pb.rotation_quaternion=q(b['localQuaternion']);pb.scale=(1,1,1)
 bpy.context.view_layer.update()

def pose_new(index):
 sample=controls['samples'][index];r=raw[index];root=p(sample['root'])
 for n in names:
  pb=rig.pose.bones[n];pb.location=(0,0,0);pb.scale=(1,1,1);set_world(n,r['rotations'][n])
 # Original relaxed per-digit fit of the retargeted source local hand pose.
 for n in names:
  if n.startswith(('thumb','index','middle','ring','pinky')):
   digit=n[:-2];joint=n[-2];pb=rig.pose.bones[n];pb.rotation_quaternion=Quaternion((1,0,0,0)).slerp(pb.rotation_quaternion,fit['relaxedFingerLocalStrength'][digit]*fit['fingerJointStrength'][joint])
 hips=rig.pose.bones['hips'];hips.location=Vector((r['pelvis'].x,0,mean_base-.95+(r['pelvis'].z-mean_source)*fit['pelvisVerticalSourceScale']))
 bpy.context.view_layer.update()
 targets={s:p(sample['feet'][s]['position'])-root for s in ['L','R']}
 # Reach-fitting is explicit pelvis-only visual fitting; fixed ankle samples stay immutable.
 dropped=0
 for _ in range(3):
  required=0
  for side in ['L','R']:
   h=rig.pose.bones['upperLeg'+side].head;target=targets[side];horizontal=(Vector((h.x,h.y,0))-Vector((target.x,target.y,0))).length
   zreach=math.sqrt(max(0,(.43+.42-.0005)**2-horizontal**2));required=max(required,h.z-target.z-zreach)
  if required<=0:break
  hips.location.z-=required;dropped+=required;bpy.context.view_layer.update()
 for side in ['L','R']:solve_leg(side,targets[side],r['poles'][side],q(sample['feet'][side]['quaternion']))
 return dropped

# Create phase as FLOAT before first key; integerIDproperties round driverinput.
rig['JogPhase']=0.0;rig['JogContextEnabled']=1
# Both full-body in-place actions share precisely the same separately previewed root path.
spec=importlib.util.spec_from_file_location('pq_channels',str(BASE/'import-reference-actions.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
records=[];actions={}
for kind in ['BASELINE_CURRENT_JOG_2p4','NIKO_JOG_SUPPORTED_V1']:
 action=bpy.data.actions.new(kind);action.use_fake_user=True;rig.animation_data_create();rig.animation_data.action=action;channels={};previous={}
 for i,sample in enumerate(controls['samples']):
  rig.animation_data.action=None
  drop=pose_new(i) if kind.startswith('NIKO') else (pose_baseline(sample) or 0)
  frame_number=1+sample['phase']*period_frames;rig.animation_data.action=action
  for n in names:
   pb=rig.pose.bones[n];rotation=pb.rotation_quaternion.copy()
   if n in previous:rotation.make_compatible(previous[n])
   previous[n]=rotation.copy();pb.rotation_quaternion=rotation
   for path in ['location','rotation_quaternion','scale']:
    for axis,value in enumerate(getattr(pb,path)):channels.setdefault((pb.path_from_id(path),axis),[]).append((frame_number,float(value)))
    if i==0:pb.keyframe_insert(data_path=path,frame=frame_number,group=n)
  rig['JogPhase']=float(sample['phase']);rig['JogContextEnabled']=1
  for prop in ['JogPhase','JogContextEnabled']:
   channels.setdefault((f'["{prop}"]',0),[]).append((frame_number,float(rig[prop])))
   if i==0:rig.keyframe_insert(data_path=f'["{prop}"]',frame=frame_number,group='AUTHORING_CONTROL_PHASE')
  if kind.startswith('NIKO'):
   root=p(sample['root']);foot_errors={side:(rig.pose.bones['foot'+side].head+root-p(sample['feet'][side]['position'])).length for side in ['L','R']}
   records.append({'phase':sample['phase'],'sourcePhase':raw[i]['sourcePhase'],'pelvisOffsetMetres':runtime_point(rig.pose.bones['hips'].location-p([sample['hips']['position'][j]-rest['hips']['localMetres'][j] for j in range(3)])),'pelvisLocalPositionMetres':[rest['hips']['localMetres'][j]+runtime_point(rig.pose.bones['hips'].location)[j] for j in range(3)],'pelvisQuaternion':runtime_q(rig.pose.bones['hips'].rotation_quaternion),'pelvisFitDropMetres':drop,'upperBodyAndHands':{n:runtime_q(rig.pose.bones[n].rotation_quaternion) for n in names if n not in ['hips','upperLegL','lowerLegL','footL','toeL','upperLegR','lowerLegR','footR','toeR']},'kneePoleRootSpace':{side:runtime_direction(raw[i]['poles'][side]) for side in ['L','R']},'footConstraintErrorMetres':foot_errors,'nativeLocal49':{n:{'location':list(rig.pose.bones[n].location),'quaternion':list(rig.pose.bones[n].rotation_quaternion)} for n in names}})
 mod.write_exact_channels(action,channels)
 # Intentional periodic cubic handles; preserve every exact pose sample and C1 seam.
 for curve in mod._curves(action):
  points=curve.keyframe_points
  if curve.data_path.startswith('['):
   for key in points:key.interpolation='LINEAR' if 'JogPhase' in curve.data_path else 'CONSTANT'
   continue
  ts=[x.co.x for x in points];vs=[x.co.y for x in points];duration=ts[-1]-ts[0]
  def slope(i):
   if i==len(points)-1:i=0
   prev=len(points)-2 if i==0 else i-1;after=i+1
   ls=(ts[i]-ts[prev]) if i else (ts[i]+duration-ts[prev]);rs=ts[after]-ts[i]
   a=(vs[i]-vs[prev])/ls;b=(vs[after]-vs[i])/rs
   if a*b<=0:return 0
   return (3*(ls+rs))/((2*rs+ls)/a+(rs+2*ls)/b)
  for i,key in enumerate(points):
   left=(ts[i]-ts[i-1]) if i else (duration-ts[-2]+ts[0]);right=(ts[i+1]-ts[i]) if i<len(points)-1 else ts[1]-ts[0];d=slope(i)
   key.interpolation='BEZIER';key.handle_left_type='FREE';key.handle_right_type='FREE';key.handle_left=(ts[i]-left/3,vs[i]-d*left/3);key.handle_right=(ts[i]+right/3,vs[i]+d*right/3)
 action.update_tag()
 for curve in mod._curves(action):curve.modifiers.new('CYCLES')
 if kind.startswith('NIKO'):
  curve_map={(c.data_path,c.array_index):c for c in mod._curves(action)}
  for sample_index,r in enumerate(records):
   def derivative(bone,prop,count):
    values=[]
    for axis in range(count):
     key=curve_map[(f'pose.bones["{bone}"].{prop}',axis)].keyframe_points[sample_index]
     handle=key.handle_right;values.append((handle.y-key.co.y)/(handle.x-key.co.x)*period_frames)
    return values
   native=derivative('hips','location',3);qhip=derivative('hips','rotation_quaternion',4)
   upper={}
   for n in r['upperBodyAndHands']:
    d=derivative(n,'rotation_quaternion',4);upper[n]=[d[1],d[3],-d[2],d[0]]
   r['tangentsPerPhase']={'pelvisLocalPositionMetres':[native[0],native[2],-native[1]],'pelvisQuaternion':[qhip[1],qhip[3],-qhip[2],qhip[0]],'upperBodyAndHands':upper}
  # Unit pole vectors are control data; periodic slopes use the same Hermite recipe.
  for i,r in enumerate(records):
   j=0 if i==N else i;before=(j-1)%N;after=(j+1)%N;poles={}
   for side in ['L','R']:
    ds=[]
    for axis in range(3):
     a=(records[j]['kneePoleRootSpace'][side][axis]-records[before]['kneePoleRootSpace'][side][axis])*N;b=(records[after]['kneePoleRootSpace'][side][axis]-records[j]['kneePoleRootSpace'][side][axis])*N
     ds.append(0 if a*b<=0 else 2*a*b/(a+b))
    poles[side]=ds
   r['tangentsPerPhase']['kneePoleRootSpace']=poles
 action['scope']='Original current-code baseline reference' if kind.startswith('BASELINE') else 'CC0 Quaternius Jog rest-frame retarget + original supported pelvis/pole/contact fitting; not mocap/new professional artist take'
 action['phaseNormalized']=True;action['referenceSpeedMetresPerSecond']=speed;action['referenceStrideMetres']=stride;action['cadenceCyclesPerSecond']=cadence;action['cycleSeconds']=period;action['sourceClip']='Jog_Fwd_Loop';action['sourcePhaseOffset']=fit['sourcePhaseOffset']
 actions[kind]=action
# Separate reference trajectory, never an adoptable runtime root track.
rig.animation_data.action=actions['NIKO_JOG_SUPPORTED_V1'];rig.location=(0,0,0);rig.rotation_quaternion=(1,0,0,0);rig.scale=(1,1,1)
wrap=bpy.data.objects.new('REFERENCE_JOG_ROOT_TRAJECTORY_2p4mps',None);bpy.context.scene.collection.objects.link(wrap);wrap['scope']='Native preview only; runtime root authority stays with released actor';rig.parent=wrap;rig.matrix_parent_inverse=Matrix.Identity(4);rig.matrix_basis=Matrix.Identity(4)
wrap.animation_data_create();path_action=bpy.data.actions.new('REFERENCE_JOG_LINEAR_ROOT_NOT_RUNTIME');path_action.use_fake_user=True;wrap.animation_data.action=path_action
for phase in [0,4]:wrap.location=(0,-phase*stride,0);wrap.keyframe_insert(data_path='location',frame=1+phase*period_frames)
for curve in path_action.fcurves:
 for key in curve.keyframe_points:key.interpolation='LINEAR'
 curve.extrapolation='LINEAR'
rig['JogContextEnabled']=1;rig['JogPhase']=0.0
for action in actions.values():
 for curve in action.fcurves:
  if curve.data_path=='["JogPhase"]':curve.update_autoflags(rig)
sc=bpy.context.scene;sc.render.fps=fps;sc.frame_start=1;sc.frame_end=math.ceil(1+4*period_frames);sc.frame_set(1)
for n in names:assert original_rest[n]==[v for row in rig.data.bones[n].matrix_local for v in row],n
manifest={'format':'playqube-native-supported-jog-controls-v1','scope':'Native review gate only; no runtime adoption or authority change','sourceBlendSHA256':'6a899f83bf3a8f26fa365ef1ad28acd074265fa0c5ea192ea502ea0f82a53e23','sourceGLBSHA256':'69591853d817488edaa8fd9bf8fc1d821eaeaf789f8627b3cd23b41c4ed67997','sourceClip':'Jog_Fwd_Loop','sourceOriginalSeconds':28/30,'referenceSpeed':speed,'referenceStride':stride,'cadence':cadence,'cycleSeconds':period,'phase':'distance/current stride;0..1 loop','supportWindows':{'L':[0,controls['stanceDuty']],'R':[.5,.5+controls['stanceDuty']]},'canonicalCoordinates':'+Y up,+Z forward,+X character left; metres; quaternionxyzw','retargetMethod':'source pose world * inverse source rest world * explicit anatomical Tpose-to-targetDOWN calibration; skipped spine/clavicle chains consolidated through world frames; final original ankle+orientation samples re-solved with source knee poles','pelvisFit':'Source lateral transfer retained; original .22m generic bounce scaled .12 around baseline reachable hip height; explicit downward reach fit only, no root/target edits','runtimeAdapterBoundary':'Freeze original baseline RunPlant plan before applying visual pelvis/poles; do not replan with new hips yaw; exported semantic controls forbid root/foot/toe tracks','runtimeChannels':['pelvisLocalPositionMetres','pelvisQuaternion','upperBodyAndHands','kneePoleRootSpace'],'channelSemantics':{'pelvisLocalPositionMetres':'ABSOLUTE canonical bone.position including rest hipsY.95; NOT native PoseBone.location/rest delta','pelvisOffsetMetres':'AUDIT ONLY sampled additive difference from exact captured baseline local position; not normative interpolated control','pelvisQuaternion':'ABSOLUTE unit canonical-local bone quaternion XYZW; assign/blend, never multiply as delta','upperBodyAndHands':'ABSOLUTE unit canonical-local quaternions XYZW; split fingers after existing hand-target owner and before temporal filtering','kneePoleRootSpace':'Unit directions in actor root canonical frame; interpolate then normalize; no targets/root/clocks'},'interpolation':{'normative':'Periodic cubic Hermite per scalar component using explicit per-phase tangents; normalize quaternion/direction results; native poses use same periodic Hermite handles','nativeIKLimitation':'Native49 solved leg curves approximate true same-target re-solve between dense keys; runtime must freeze baseline plan then solve at actual sample, not import native leg tracks'},'baselineContactSamplesSha256':hashlib.sha256((P/'baseline-contact-samples.json').read_bytes()).hexdigest(),'canonicalRestSha256':hashlib.sha256(json.dumps(contract['rig'],sort_keys=True,separators=(',',':')).encode()).hexdigest(),'newArtistryLimit':'Properly retargeted CC0 artist source with original contact/deformation fit; not a professional football animator finishing pass. Visual review pending.','mapping':{n:{'source':a,'sourceAnatomicalChild':b,'sourceRestMatrix':[v for row in (source.matrix_world@source.data.bones[a].matrix_local) for v in row],'targetAnatomicalRestFrame':list(T0[n]),'explicitRestCalibration':list(calibration[n])} for n,(a,b) in MAP.items()},'authoringFit':fit,'authoringFitSource':fit_path.name,'armTransport':'NewFittedWorldChest * inverse OriginalRetargetedWorldChest (before all pitch/roll/yaw fitting), applied to complete arm/hand/finger subtree before compact arm calibration' if fit.get('transportUpperBodyRelativeToChest',False) else 'V1 retained original source global arm frame','samples':[{k:v for k,v in r.items() if k!='nativeLocal49'} for r in records]}
(WORK/'native-jog-local-poses.json').write_text(json.dumps({'scope':'Native action authoring/reference only, not adoptable runtime foot/root tracks','samples':[{'phase':r['phase'],'local49':r['nativeLocal49']} for r in records]},indent=2)+'\n')
(WORK/'jog-controls.json').write_text(json.dumps(manifest,indent=2)+'\n')
(WORK/'jog-authoring-report.json').write_text(json.dumps({'source':str(BASE/'native/PlayQube_ReviewPlayer_Baseline.blend'),'sourceHash':manifest['sourceBlendSHA256'],'nativeOutput':str(OUT),'samples':len(records),'maxAnkleError':max(max(r['footConstraintErrorMetres'].values()) for r in records),'maxPelvisFitDrop':max(r['pelvisFitDropMetres'] for r in records),'actions':list(actions),'sourceAction':source_action.name,'sourcePhaseOffset':fit['sourcePhaseOffset'],'rootTracks':'separate reference-only object/action','loopEndpoints':'pending independent validation'},indent=2)+'\n')
# Place the existing camera for a usable one-cycle default; capture script records exact views.
cam=sc.camera;target=Vector((0,-stride/2,.95));cam.location=target+Vector((3,-4,.3));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=3.4
def assert_fractional_phase():
 rows=[]
 for name in ['BASELINE_CURRENT_JOG_2p4','NIKO_JOG_SUPPORTED_V1']:
  rig.animation_data.action=bpy.data.actions[name]
  for phase in [0,.125,.25,.375,.5,.625,.75,.875]:
   f=1+phase*period_frames;sc.frame_set(math.floor(f),subframe=f%1);bpy.context.view_layer.update();value=rig['JogPhase'];assert isinstance(value,float) and abs(value-phase)<2e-6,(name,phase,value);rows.append({'action':name,'phase':phase,'evaluatedPhase':value})
 rig.animation_data.action=bpy.data.actions['NIKO_JOG_SUPPORTED_V1'];sc.frame_set(1)
 return rows
phase_rows=assert_fractional_phase()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT),compress=True)
if opts.check:
 bpy.ops.wm.open_mainfile(filepath=str(OUT));rig=bpy.data.objects['Production49'];sc=bpy.context.scene
 reopened=assert_fractional_phase();assert phase_rows==reopened
 (WORK/'source-check-report.json').write_text(json.dumps({'status':'pass','phaseType':type(rig['JogPhase']).__name__,'phaseSamplesBeforeAndAfterReopen':reopened,'rootReferenceExtrapolation':[f.extrapolation for f in bpy.data.actions['REFERENCE_JOG_LINEAR_ROOT_NOT_RUNTIME'].fcurves],'sourceInputUnchangedSHA256':hashlib.sha256((BASE/'native/PlayQube_ReviewPlayer_Baseline.blend').read_bytes()).hexdigest(),'outputSHA256':hashlib.sha256(OUT.read_bytes()).hexdigest()},indent=2)+'\n')
print(json.dumps({'output':str(OUT),'sha256':hashlib.sha256(OUT.read_bytes()).hexdigest(),'samples':len(records),'maxAnkleError':max(max(r['footConstraintErrorMetres'].values()) for r in records)}))
