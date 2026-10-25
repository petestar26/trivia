"""Read-only native deformation diagnostic sweeps. Encoded rate is playback only.
No foot/root/ball/clock authority, no claim of runtime/native browser FPS.
"""
import bpy,json,math,hashlib,time,sys,argparse
from pathlib import Path
from mathutils import Matrix,Vector,Quaternion
R=Path(__file__).resolve().parents[1];src=json.loads((R/'verified-source/bridge/assembled-niko-bind.json').read_text());rig=bpy.data.objects['Production49'];scene=bpy.context.scene
ap=argparse.ArgumentParser();ap.add_argument('--out',type=Path,default=R/'geometry/inspection-sweeps-v4');ap.add_argument('--frames',type=int,default=49);opt=ap.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []);opt.out.mkdir(parents=True,exist_ok=True)
C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)));CQ=Quaternion((1,0,0),math.pi/2)
sourcepath=Path(bpy.data.filepath);sourcehash=hashlib.sha256(sourcepath.read_bytes()).hexdigest();cam=scene.camera;cam.parent=None;cam.matrix_parent_inverse=Matrix.Identity(4);wrap=bpy.data.objects['REFERENCE_JOG_ROOT_TRAJECTORY_2p4mps'];wrap.animation_data_clear();wrap.matrix_world=Matrix.Identity(4);rig.animation_data.action=None;rig.matrix_basis=Matrix.Identity(4);rig['JogContextEnabled']=0.0
scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=4;scene.cycles.use_denoising=True;scene.render.resolution_x=360;scene.render.resolution_y=360;scene.render.resolution_percentage=100;scene.view_settings.view_transform='Standard';scene.view_settings.exposure=-1
scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.25,.25,.25,1);scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.6
rest=src['poseVariants']['bindNeutral']['bones'];restmap={b['name']:b for b in src['rig']['bones']};ledger=[]
def apply(pose,ratio):
 for source,b in zip(rest,pose['bones']):
  assert source['name']==b['name'];ob=rig.pose.bones[b['name']];r=restmap[b['name']];p=[source['localPosition'][k]*(1-ratio)+b['localPosition'][k]*ratio-r['localPosition'][k] for k in range(3)];ob.location=C.to_3x3()@Vector(p)
  a=source['localQuaternion'];z=b['localQuaternion'];q=Quaternion((a[3],a[0],a[1],a[2])).slerp(Quaternion((z[3],z[0],z[1],z[2])),ratio);ob.rotation_mode='QUATERNION';ob.rotation_quaternion=CQ@q@CQ.conjugated();ob.scale=[source['localScale'][k]*(1-ratio)+b['localScale'][k]*ratio for k in range(3)]
 bpy.context.view_layer.update()
for kind,peak,views in [('shoulder',math.pi/2,['front','side']),('knee',2*math.pi/3,['side'])]:
 pose=min([s for s in src['correctiveSamples'] if s['definition']['kind']==kind],key=lambda x:abs(x['definition']['angle']-peak))['pose']
 for view in views:
  folder=opt.out/f'{kind}-{view}';folder.mkdir(exist_ok=True)
  for frame in range(opt.frames):
   ratio=.5-.5*math.cos(2*math.pi*frame/(opt.frames-1));apply(pose,ratio);target=(rig.matrix_world@rig.pose.bones['chest' if kind=='shoulder' else 'lowerLegL'].matrix).translation+Vector((0,0,.14 if kind=='shoulder' else .01));cam.location=target+Vector((0,-4,0) if view=='front' else (4,0,0));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=.8 if kind=='shoulder' else .62;bpy.context.view_layer.update();out=folder/f'{frame:04d}.png';scene.render.filepath=str(out);start=time.monotonic();bpy.ops.render.render(write_still=True)
   row={'file':str(out.relative_to(opt.out)),'sourceBlendSHA256':sourcehash,'kind':kind,'view':view,'frame':frame,'angleDegrees':math.degrees(peak)*ratio,'diagnosticPoseSource':'Bind neutral→existing exact49 diagnostic FK peak, sinusoidal up/down interpolation. Not locomotion or authoritative playback.','camera':{'matrixWorld':[list(r) for r in cam.matrix_world],'position':list(cam.location),'target':list(target),'rotation':list(cam.rotation_euler),'orthoScale':cam.data.ortho_scale},'full49PoseSHA256':hashlib.sha256(json.dumps([{'name':b.name,'position':list(b.location),'q':list(b.rotation_quaternion)} for b in rig.pose.bones],sort_keys=True).encode()).hexdigest(),'driverValues':{n:rig[n] for n in rig.keys() if n.startswith('R11_')},'activeShapeKeys':{o.name:{k.name:k.value for k in o.data.shape_keys.key_blocks if k.name.startswith('R11_') and abs(k.value)>1e-6} for o in bpy.data.objects if o.type=='MESH' and o.name in ['niko-body','niko-jersey','niko-socks']},'CPUOfflineRenderSeconds':time.monotonic()-start,'playbackFPS':10,'runtimeFPS':None,'sha256':hashlib.sha256(out.read_bytes()).hexdigest()};ledger.append(row);(opt.out/'ledger.json').write_text(json.dumps(ledger,indent=2)+'\n')
assert hashlib.sha256(sourcepath.read_bytes()).hexdigest()==sourcehash
print('READONLY_SWEEPS',len(ledger),sourcehash)
