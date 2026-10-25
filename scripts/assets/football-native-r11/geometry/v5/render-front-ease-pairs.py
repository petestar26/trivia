"""Exact V4 vs V5 jersey-only samepose native comparison, read-only source."""
import bpy,json,hashlib,time,math
from pathlib import Path
from mathutils import Vector,Matrix
R=Path(__file__).resolve().parents[2];G=R/'geometry';O=G/'v5/phase-one-third-pairs';O.mkdir(parents=True,exist_ok=True);sc=bpy.context.scene;rig=bpy.data.objects['Production49'];ob=bpy.data.objects['niko-jersey'];old=ob.data
with bpy.data.libraries.load(str(G/'v5/Player_Deformation.blend'),link=False) as (s,t):t.meshes=['niko-jersey_Data']
new=t.meshes[0]
for f in new.shape_keys.animation_data.drivers:
 for var in f.driver.variables:
  for target in var.targets:
   if target.id and target.id.type=='ARMATURE':target.id=rig
assert len(new.vertices)==len(old.vertices)==1794
controls=json.loads((R/'motion/v2/jog-controls.json').read_text());phase=1/3;frame=1+phase*30/controls['cadence'];rig.animation_data.action=bpy.data.actions['NIKO_JOG_SUPPORTED_V1'];sc.frame_set(math.floor(frame),subframe=frame%1);bpy.context.view_layer.update();cam=sc.camera;cam.parent=None;cam.matrix_parent_inverse=Matrix.Identity(4)
sc.render.engine='CYCLES';sc.cycles.device='CPU';sc.cycles.samples=10;sc.cycles.use_denoising=True;sc.view_settings.view_transform='Standard';sc.view_settings.exposure=-1;sc.view_settings.gamma=1.;sc.render.threads_mode='FIXED';sc.render.threads=4
for light in [x for x in bpy.data.objects if x.type=='LIGHT']:light.hide_render=True
sc.world.use_nodes=True;sc.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.25,.25,.25,1);sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.6;lights=[]
for name,position,energy,size in [('key',(-3,-4,5),450,3),('fill',(3,-2,3),250,3),('rim',(0,3,4),350,2.5)]:
 data=bpy.data.lights.new('R11_CAPTURE_'+name,'AREA');data.energy=energy;data.shape='DISK';data.size=size;light=bpy.data.objects.new(data.name,data);sc.collection.objects.link(light);light.location=position;light.rotation_euler=(Vector((0,-.7,.95))-light.location).to_track_quat('-Z','Y').to_euler();lights.append({'name':name,'position':position,'energy':energy,'size':size,'rotation':list(light.rotation_euler)})
ledger=[]
def posehash():return hashlib.sha256(json.dumps([{'name':p.name,'q':list(p.rotation_quaternion),'loc':list(p.location),'scale':list(p.scale)} for p in rig.pose.bones],sort_keys=True).encode()).hexdigest()
for label,view,z,scale,size in [('full-front','front',.96,2.15,(320,480)),('front-close','front',1.21,.55,(512,512)),('profile-close','side',1.21,.55,(512,512))]:
 target=rig.matrix_world.translation+Vector((0,0,z));cam.location=target+(Vector((0,-4,.08)) if view=='front' else Vector((4,0,.08)));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=scale;sc.render.resolution_x,sc.render.resolution_y=size;sc.render.resolution_percentage=100
 for mode,mesh in [('before-v4',old),('after-v5',new)]:
  ob.data=mesh;bpy.context.view_layer.update();path=O/f'{label}-{mode}.png';sc.render.filepath=str(path);start=time.monotonic();bpy.ops.render.render(write_still=True);ledger.append({'file':path.name,'mode':mode,'phase':phase,'nativeFrame':frame,'poseSHA256':posehash(),'sourceBeforeCombinedSHA256':'a7d496c22dea5775c5f53318e795a44884b3869fd0e4004060e53055636947fc','sourceAfterGeometrySHA256':hashlib.sha256((G/'v5/Player_Deformation.blend').read_bytes()).hexdigest(),'camera':{'matrixWorld':[list(x) for x in cam.matrix_world],'position':list(cam.location),'target':list(target),'rotation':list(cam.rotation_euler),'orthoScale':scale},'lighting':lights,'renderer':'CyclesCPU10samples native source-only, not browser/device/performance proof','seconds':time.monotonic()-start,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()});(O/'ledger.json').write_text(json.dumps(ledger,indent=2)+'\n')
 assert ledger[-1]['poseSHA256']==ledger[-2]['poseSHA256']
print('FRONT_EASE_SAMEPOSE_PAIRS',len(ledger))
