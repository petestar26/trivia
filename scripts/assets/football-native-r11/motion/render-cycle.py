"""Matched actual native jog capture. Never saves/changes the source blend."""
import argparse,json,sys,math,time,hashlib
from pathlib import Path
import bpy
from mathutils import Vector
ap=argparse.ArgumentParser();ap.add_argument('--out',type=Path,required=True);ap.add_argument('--controls',type=Path);ap.add_argument('--frames',type=int,default=48);ap.add_argument('--mode',choices=['before','after','both'],default='both');ap.add_argument('--category',default='motion-only-constant-geometry');ap.add_argument('--size',type=int,default=320);ap.add_argument('--view',choices=['front','side','both'],default='both');args=ap.parse_args(sys.argv[sys.argv.index('--')+1:]);args.out.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parent;controls_path=args.controls or root/'jog-controls.json';data=json.loads(controls_path.read_text());rig=bpy.data.objects['Production49'];sc=bpy.context.scene;cam=sc.camera
blend_path=Path(bpy.data.filepath);before_hash=hashlib.sha256(blend_path.read_bytes()).hexdigest();pf=30/data['cadence'];sc.render.engine='CYCLES';sc.cycles.device='CPU';sc.cycles.samples=6;sc.cycles.use_denoising=True;sc.render.resolution_x=args.size;sc.render.resolution_y=round(args.size*1.5);sc.render.resolution_percentage=100;sc.render.image_settings.file_format='PNG';sc.view_settings.view_transform='Standard';sc.view_settings.exposure=-1.0;sc.view_settings.gamma=1.0;sc.render.threads_mode='FIXED';sc.render.threads=4
# Explicit unsaved capture-only lighting ensures original/merged geometries match.
for light in [o for o in bpy.data.objects if o.type=='LIGHT']:light.hide_render=True
sc.world.use_nodes=True;sc.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.25,.25,.25,1);sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.6
lighting=[]
for name,location,energy,size in [('key',(-3,-4,5),450,3),('fill',(3,-2,3),250,3),('rim',(0,3,4),350,2.5)]:
 light=bpy.data.lights.new('R11_CAPTURE_'+name,'AREA');light.energy=energy;light.shape='DISK';light.size=size;ob=bpy.data.objects.new(light.name,light);sc.collection.objects.link(ob);ob.location=location;ob.rotation_euler=(Vector((0,-.7,.95))-ob.location).to_track_quat('-Z','Y').to_euler();lighting.append({'name':name,'position':location,'energyWatts':energy,'sizeMetres':size,'rotation':list(ob.rotation_euler)})
# Remove camera parenting only in the unsaved capture session; paired poses use recorded tracking transforms.
cam.parent=None;cam.data.type='ORTHO';cam.data.ortho_scale=2.15
for ob in bpy.data.objects:
 if ob.type=='MESH' and ob.data.shape_keys:
  for key in ob.data.shape_keys.key_blocks:
   if key.name.startswith('BASELINE_SAMPLED'):key.value=0
# Identical unsaved diagnostic plane for both sources; retain the saved datum unchanged.
mesh=bpy.data.meshes.new('R11_CAPTURE_STANDARD_GROUND_MESH');mesh.from_pydata([(-15,-15,0),(15,-15,0),(15,15,0),(-15,15,0)],[],[(0,1,2,3)])
floor=bpy.data.objects.get('JOG_PROOF_GROUND')
if floor is None:
 floor=bpy.data.objects.new('JOG_PROOF_GROUND',mesh);sc.collection.objects.link(floor)
else:floor.data=mesh
floor.parent=None;floor.location=(0,0,0);floor.rotation_euler=(0,0,0);floor.scale=(1,1,1);floor.hide_render=False
standard_ground=bpy.data.materials.new('R11_CAPTURE_STANDARD_GROUND');standard_ground.use_nodes=True;standard_ground.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.1,.14,.11,1);standard_ground.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.95;mesh.materials.append(standard_ground)
ledger={'scope':'Native Blender CPU authoring comparison; not actual match, browser emulation, runtime FPS or physical-device validation','sourceBlend':str(blend_path),'sourceBlendSHA256':before_hash,'controlUse':'Same normalizedphase/cadence metadata; before action is accepted baseline, after action is authored supportedretarget','sourceControlsSha256':hashlib.sha256(controls_path.read_bytes()).hexdigest(),'samplesPerCycle':args.frames,'cadence':data['cadence'],'cycleSeconds':1/data['cadence'],'normalEncodedFPS':args.frames*data['cadence'],'comparisonCategory':args.category,'lighting':lighting,'captureGround':{'vertices':[list(v.co) for v in mesh.vertices],'worldTranslation':list(floor.location),'material':{'baseColor':[.1,.14,.11,1],'roughness':.95}},'camera':'paired root-tracking views; exact transforms recorded per sourceframe','render':{'engine':'CYCLES','device':'CPU','samples':6,'width':sc.render.resolution_x,'height':sc.render.resolution_y,'colorTransform':'Standard','exposure':sc.view_settings.exposure,'gamma':sc.view_settings.gamma,'look':sc.view_settings.look},'frames':[]}
for i in range(args.frames):
 phase=i/args.frames;frame=1+phase*pf
 for mode,action in [('before','BASELINE_CURRENT_JOG_2p4'),('after','NIKO_JOG_SUPPORTED_V1')]:
  if args.mode!='both' and mode!=args.mode:continue
  rig.animation_data.action=bpy.data.actions[action];sc.frame_set(math.floor(frame),subframe=frame%1);bpy.context.view_layer.update()
  for view in (['front','side'] if args.view=='both' else [args.view]):
   target=rig.matrix_world.translation+Vector((0,0,.96));cam.location=target+Vector((0,-4,.08) if view=='front' else (4,0,.08));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();sc.render.filepath=str(args.out/f'{view}-{mode}-{i:04}.png');start=time.monotonic();bpy.ops.render.render(write_still=True)
   ledger['frames'].append({'file':Path(sc.render.filepath).name,'mode':mode,'action':action,'view':view,'phase':phase,'nativeFrame':frame,'referenceSeconds':phase/data['cadence'],'rootReferenceMetres':list(rig.matrix_world.translation),'cameraPosition':list(cam.location),'cameraTarget':list(target),'cameraRotation':list(cam.rotation_euler),'orthographicScale':cam.data.ortho_scale,'wallSeconds':time.monotonic()-start,'sha256':hashlib.sha256(Path(sc.render.filepath).read_bytes()).hexdigest()})
   (args.out/f'capture-ledger-{args.mode}.json').write_text(json.dumps(ledger,indent=2)+'\n')
assert hashlib.sha256(blend_path.read_bytes()).hexdigest()==before_hash
print(json.dumps({'frames':len(ledger['frames']),'sourceUnchanged':True,'out':str(args.out)}))
