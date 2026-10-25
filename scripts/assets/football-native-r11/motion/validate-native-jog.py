import bpy,json,math,hashlib,time,argparse,sys
from pathlib import Path
from mathutils import Matrix,Vector,Quaternion
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--controls',type=Path,default=P/'jog-controls.json');ap.add_argument('--out',type=Path,default=P/'native-jog-validation-current.json');opts=ap.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []);loaded_blend_hash=hashlib.sha256(Path(bpy.data.filepath).read_bytes()).hexdigest();data=json.loads(opts.controls.read_text());base=json.loads((P/'baseline-contact-samples.json').read_text());rig=bpy.data.objects['Production49'];wrap=bpy.data.objects['REFERENCE_JOG_ROOT_TRAJECTORY_2p4mps'];sc=bpy.context.scene
period=1/data['cadence'];pf=period*30;names=list(json.loads((P/'native-jog-local-poses.json').read_text())['samples'][0]['local49']);C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)))
def at(phase,action='NIKO_JOG_SUPPORTED_V1'):
 rig.animation_data.action=bpy.data.actions[action];f=1+phase*pf;sc.frame_set(math.floor(f),subframe=f%1);bpy.context.view_layer.update()
def vec(p):return Vector((p[0],-p[2],p[1]))
def worldbone(n):return rig.matrix_world@rig.pose.bones[n].matrix
matrixerrors=[];sole={'L':{'heel':[],'ball':[]},'R':{'heel':[],'ball':[]}};boot_min=[];orientation=[]
boot=bpy.data.objects['niko-boots'];rest_x=[v.co.x for v in boot.data.vertices]
for i,sample in enumerate(base['samples']):
 phase=sample['phase'];at(phase)
 for side in ['L','R']:
  m=worldbone('foot'+side);target=vec(sample['feet'][side]['position']);matrixerrors.append((m.translation-target).length)
  a=sample['feet'][side]['quaternion'];q=Quaternion((a[3],a[0],a[1],a[2]));expected=C.to_quaternion()@q@C.to_quaternion().conjugated();orientation.append(m.to_quaternion().rotation_difference(expected).angle)
  heel=m@Vector((0,.07,-.07));ball=m@Vector((0,-.15,-.068));p=(phase+(.5 if side=='R' else 0))%1;duty=base['stanceDuty'];u=p/duty
  if p<duty and phase<1-1e-9:
   if u<=.3:sole[side]['heel'].append({'phase':phase,'point':list(heel)})
   if u>=.55:sole[side]['ball'].append({'phase':phase,'point':list(ball)})
 evaluated=boot.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=evaluated.to_mesh()
 minimum={'L':1e9,'R':1e9}
 for j,v in enumerate(mesh.vertices):
  side='L' if rest_x[j]>0 else 'R';minimum[side]=min(minimum[side],(evaluated.matrix_world@v.co).z)
 evaluated.to_mesh_clear();boot_min.append({'phase':phase,**minimum})
# Finite-difference pose velocities are explicit source diagnostics, not frame-rate claims.
def pose(phase):
 at(phase);return {n:{'p':rig.pose.bones[n].location.copy(),'q':rig.pose.bones[n].rotation_quaternion.copy()} for n in names}
a=pose(0);b=pose(1);h=1/240;prev=pose(1-h);nxt=pose(h);loop={};maxpos=0;maxrot=0;maxpvel=0;maxrvel=0
for n in names:
 dp=(a[n]['p']-b[n]['p']).length;dq=a[n]['q'].rotation_difference(b[n]['q']).angle
 vp=(nxt[n]['p']-a[n]['p'])/(h*period);vm=(b[n]['p']-prev[n]['p'])/(h*period)
 def angular(q0,q1):
  q0=q0.copy();q1=q1.copy();q1.make_compatible(q0);d=q0.conjugated()@q1;axis,angle=d.to_axis_angle();return axis*angle/(h*period)
 ve=(angular(a[n]['q'],nxt[n]['q'])-angular(prev[n]['q'],b[n]['q'])).length
 loop[n]={'positionEndpointError':dp,'rotationEndpointErrorRadians':dq,'positionVelocityMismatch':(vp-vm).length,'angularVelocityMismatchRadiansPerSecond':ve};maxpos=max(maxpos,dp);maxrot=max(maxrot,dq);maxpvel=max(maxpvel,(vp-vm).length);maxrvel=max(maxrvel,ve)
for side in sole:
 for marker,samples in sole[side].items():
  # Each recorded window is one complete stance at the reference speed.
  points=[Vector(x['point']) for x in samples];origin=points[0];sole[side][marker]={'samples':len(points),'maxWorldDrift':max((x-origin).length for x in points),'minNativeZ':min(x.z for x in points),'maxNativeZ':max(x.z for x in points)}
# Analytic periodic channel endpoint derivatives (finite2.5ms probe above includes acceleration).
action=bpy.data.actions['NIKO_JOG_SUPPORTED_V1'];curves={(f.data_path,f.array_index):f for f in action.fcurves}
analytic={};analytic_max_angular=0.;analytic_max_translation=0.
def derivative(curve,start):
 key=curve.keyframe_points[0 if start else -1];handle=key.handle_right if start else key.handle_left
 return (handle.y-key.co.y)/(handle.x-key.co.x)*30
for n in names:
 def vals(prop):
  fs=[curves[(f'pose.bones["{n}"].{prop}',i)] for i in range(4 if prop=='rotation_quaternion' else 3)]
  return [derivative(f,True) for f in fs],[derivative(f,False) for f in fs]
 dl,dr=vals('location');translation=math.sqrt(sum((x-y)**2 for x,y in zip(dl,dr)));analytic_max_translation=max(analytic_max_translation,translation)
 q0=[curves[(f'pose.bones["{n}"].rotation_quaternion',i)].keyframe_points[0].co.y for i in range(4)];q1=[curves[(f'pose.bones["{n}"].rotation_quaternion',i)].keyframe_points[-1].co.y for i in range(4)];vl,vr=vals('rotation_quaternion')
 def angular_velocity(q,d):
  w,x,y,z=q;a,b,c,e=d
  return [2*(w*b-x*a-y*e+z*c),2*(w*c+x*e-y*a-z*b),2*(w*e-x*c+y*b-z*a)]
 wl=angular_velocity(q0,vl);wr=angular_velocity(q1,vr);angular=math.sqrt(sum((x-y)**2 for x,y in zip(wl,wr)));analytic_max_angular=max(analytic_max_angular,angular);analytic[n]={'localTranslationDerivativeMismatch':translation,'angularDerivativeMismatchRadiansPerSecond':angular}
dense_error=0.;dense_stance_error=0.;dense_swing_error=0.;dense_boot_min={'L':1e9,'R':1e9};dense_active_sole={'L':{'heel':[],'ball':[]},'R':{'heel':[],'ball':[]}}
for i in range(len(base['samples'])-1):
 phase=(i+.5)/base['divisions'];at(phase)
 evaluated=boot.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=evaluated.to_mesh()
 for j,v in enumerate(mesh.vertices):
  side='L' if rest_x[j]>0 else 'R';dense_boot_min[side]=min(dense_boot_min[side],(evaluated.matrix_world@v.co).z)
 evaluated.to_mesh_clear()
 for side in ['L','R']:
  expected=(vec(base['samples'][i]['feet'][side]['position'])+vec(base['samples'][i+1]['feet'][side]['position']))*.5;error=(worldbone('foot'+side).translation-expected).length;dense_error=max(dense_error,error)
  p=(phase+(.5 if side=='R' else 0))%1;u=p/base['stanceDuty']
  if p<base['stanceDuty']:
   dense_stance_error=max(dense_stance_error,error);m=worldbone('foot'+side)
   if u<=.3:dense_active_sole[side]['heel'].append(m@Vector((0,.07,-.07)))
   if u>=.55:dense_active_sole[side]['ball'].append(m@Vector((0,-.15,-.068)))
  else:dense_swing_error=max(dense_swing_error,error)
dense_sole_summary={}
for side in dense_active_sole:
 dense_sole_summary[side]={}
 for marker,points in dense_active_sole[side].items():
  dense_sole_summary[side][marker]={'samples':len(points),'worldDrift':max((x-points[0]).length for x in points),'minimumZ':min(x.z for x in points)}
report={'denseStanceAnkleErrorVsFrozenLinearReference':dense_stance_error,'denseSwingAnkleErrorVsFrozenLinearReference':dense_swing_error,'denseActualBootMinZ':dense_boot_min,'denseActiveSoleWindows':dense_sole_summary,'analyticEndpointMaxAngularVelocityMismatch':analytic_max_angular,'analyticEndpointMaxTranslationVelocityMismatch':analytic_max_translation,'analyticEndpointByBone':analytic,'denseMidpointAnkleErrorVsFrozenReferenceLinearInterpolation':dense_error,'status':'measured-native-first-candidate; visual inspection pending','maxAnklePositionError':max(matrixerrors),'maxFootOrientationErrorRadians':max(orientation),'soleDatumWindows':sole,'minVisibleBootNativeZ':{s:min(x[s] for x in boot_min) for s in ['L','R']},'visibleBootCorrectionScope':('Accepted source CPU241-key boot reference active in this validated nativejog context; no new boot rule/target change' if boot.data.shape_keys and len(boot.data.shape_keys.key_blocks)>1 else 'Native lacks accepted CPUbootflex reference; historical limitation only'),'bootPhaseSamples':boot_min,'loopEndpointMaxPositionError':maxpos,'loopEndpointMaxRotationErrorRadians':maxrot,'loopVelocityProbeIntervalSeconds':h*period,'loopMaxPositionVelocityMismatch':maxpvel,'loopMaxAngularVelocityMismatch':maxrvel,'loopByBone':loop,'sourceBlendSHA256':loaded_blend_hash,'sourceControlsSHA256':hashlib.sha256(opts.controls.read_bytes()).hexdigest(),'scope':'Native physical/sole output diagnostics; no runtime adoption, FPS or device acceptance'}
opts.out.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in ['bootPhaseSamples','loopByBone','analyticEndpointByBone']}))

assert hashlib.sha256(Path(bpy.data.filepath).read_bytes()).hexdigest()==loaded_blend_hash,'Source changed during read-only metrics'
