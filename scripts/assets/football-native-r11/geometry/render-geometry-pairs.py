"""True geometry-only authoring pairs: identical FK pose/light/world camera.
Before swaps only3 R10mesh data; bothcases retain the same acceptedbootadapter.
Held static before uses exact retained old CPU sample where available, labelled.
"""
import bpy,json,math,time,hashlib,argparse,sys
from pathlib import Path
from mathutils import Matrix,Vector,Quaternion
R=Path(__file__).resolve().parents[1];G=R/'geometry';src=json.loads((R/'verified-source/bridge/assembled-niko-bind.json').read_text());rig=bpy.data.objects['Production49'];wrap=bpy.data.objects['REFERENCE_JOG_ROOT_TRAJECTORY_2p4mps'];sc=bpy.context.scene;CQ=Quaternion((1,0,0),math.pi/2);C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)))
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [];ap=argparse.ArgumentParser();ap.add_argument('--out',type=Path,default=G/'matched-pose-views');ap.add_argument('--quick',action='store_true');ap.add_argument('--held-gate',action='store_true');o=ap.parse_args(args);o.out.mkdir(parents=True,exist_ok=True)
objects=[bpy.data.objects[n] for n in ['niko-body','niko-jersey','niko-socks']];after={ob.name:ob.data for ob in objects}
with bpy.data.libraries.load(str(R/'verified-source/native/PlayQube_ReviewPlayer_Baseline.blend'),link=False) as (s,t):t.meshes=[n+'_Data' for n in ['niko-body','niko-jersey','niko-socks']]
before={ob.name:me for ob,me in zip(objects,t.meshes)}
cam=sc.camera;cam.parent=None;cam.matrix_parent_inverse=Matrix.Identity(4);sc.render.engine='CYCLES';sc.cycles.device='CPU';sc.cycles.samples=6;sc.cycles.use_denoising=True;sc.render.resolution_x=480;sc.render.resolution_y=480;sc.render.resolution_percentage=100;sc.view_settings.view_transform='Standard';sc.view_settings.exposure=-1
sc.world.use_nodes=True;sc.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.25,.25,.25,1);sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.6
SOURCE_BLEND_SHA256=hashlib.sha256(Path(bpy.data.filepath).read_bytes()).hexdigest()
ledger=[]
def pose_hash():return hashlib.sha256(json.dumps([{'name':b.name,'location':list(b.location),'quaternion':list(b.rotation_quaternion),'scale':list(b.scale)} for b in rig.pose.bones],sort_keys=True,separators=(',',':')).encode()).hexdigest()
def switch(mode,static_sample=None):
 for ob in objects:
  ob.data=(before if mode=='before' else after)[ob.name]
  if ob.data.shape_keys:
   for k in ob.data.shape_keys.key_blocks:
    if k.name.startswith('BASELINE_SAMPLED'):
     k.value=1 if mode=='before' and static_sample and k.name==static_sample else 0
 bpy.context.view_layer.update()
def point(v):return Vector((v[0],-v[2],v[1]))
def static_pose(pose):
 rig.animation_data.action=None;wrap.animation_data_clear();wrap.matrix_world=Matrix.Identity(4);rig.matrix_basis=Matrix.Identity(4);rig['JogContextEnabled']=0.0
 for b in pose['bones']:
  p=rig.pose.bones[b['name']];r=next(x for x in src['rig']['bones'] if x['name']==b['name']);p.location=point([b['localPosition'][i]-r['localPosition'][i] for i in range(3)]);q=b['localQuaternion'];p.rotation_mode='QUATERNION';p.rotation_quaternion=CQ@Quaternion((q[3],q[0],q[1],q[2]))@CQ.conjugated();p.scale=b['localScale']
 bpy.context.view_layer.update()
def shot(label,view,target,scale,posemeta,sample=None):
 target=Vector(target);cam.location=target+Vector((0,-4,0) if view=='front' else (4,0,0));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=scale
 bpy.context.view_layer.update();matrix=[list(row) for row in cam.matrix_world]
 for mode in ['before','after']:
  switch(mode,sample);name=f'{label}-{view}-{mode}.png';sc.render.filepath=str(o.out/name);start=time.monotonic();bpy.ops.render.render(write_still=True)
  values={ob.name:{k.name:k.value for k in ob.data.shape_keys.key_blocks if k.name.startswith('R11_')} for ob in objects if ob.data.shape_keys}
  ledger.append({'file':name,'sourceAfterBlendSHA256':SOURCE_BLEND_SHA256,'sourceBeforeGeometryBlendSHA256':'6a899f83bf3a8f26fa365ef1ad28acd074265fa0c5ea192ea502ea0f82a53e23','mode':mode,'pose':posemeta,'full49PoseSHA256':pose_hash(),'camera':{'matrixWorld':matrix,'position':list(cam.location),'target':list(target),'rotation':list(cam.rotation_euler),'orthoScale':scale},'viewTransform':'Standard','exposure':-1,'lights':[{'name':x.name,'matrixWorld':[list(row) for row in x.matrix_world],'energy':x.data.energy,'size':x.data.size} for x in bpy.data.objects if x.type=='LIGHT'],'baselineScope':'R10geometry plus retained exact staticCPU sample whenprovided; otherwise nativepose-only before. Same acceptedbootadapter both. Not actualmatchruntime comparison.','staticBaselineSample':sample,'afterDriverValues':values,'nativeCPUSeconds':time.monotonic()-start,'sha256':hashlib.sha256((o.out/name).read_bytes()).hexdigest()})
  if mode=='after':assert ledger[-1]['full49PoseSHA256']==ledger[-2]['full49PoseSHA256'],'Non-identical source pose pair'
  (o.out/'ledger.json').write_text(json.dumps(ledger,indent=2)+'\n')
# SAME newlyauthored jog poses before/after isolates source garment/deformation.
for phase in ([] if o.held_gate else ([0,.25] if o.quick else [0,.25,.5])):
 rig.animation_data.action=bpy.data.actions['NIKO_JOG_SUPPORTED_V1'];f=1+phase*30/1.654;sc.frame_set(math.floor(f),subframe=f%1);bpy.context.view_layer.update();target=(rig.matrix_world@rig.pose.bones['chest'].matrix).translation+Vector((0,0,.14))
 for view in ['front','side']:shot(f'jog-{phase:.2f}-collar',view,target,.78,{'action':'NIKO_JOG_SUPPORTED_V1','phase':phase,'identicalFK':True})
if not o.quick:
 for kind,degrees_list in [('shoulder',[90] if o.held_gate else [30,60,90]),('knee',[60,90,120])]:
  for degrees in degrees_list:
   a=math.radians(degrees);sample=min([s for s in src['correctiveSamples'] if s['definition']['kind']==kind],key=lambda s:abs(s['definition']['angle']-a));assert abs(sample['definition']['angle']-a)<1e-5;static_pose(sample['pose'])
   target=(rig.matrix_world@rig.pose.bones['chest' if kind=='shoulder' else 'lowerLegL'].matrix).translation+Vector((0,0,.14 if kind=='shoulder' else .01))
   for view in (['front','side'] if kind=='shoulder' else ['side']):shot(f'{kind}-{degrees}',view,target,.80 if kind=='shoulder' else .62,{'sourcePose':sample['name'],'angleDegrees':degrees,'identicalFK':True},sample['name'])
print('GEOMETRY_PAIRS',len(ledger),o.out)
