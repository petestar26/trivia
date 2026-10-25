"""New combined copy only: source geometry/driver merge; does not edit actions."""
import bpy,json,hashlib,base64,array,math,importlib.util,sys
from pathlib import Path
from mathutils import Matrix
R=Path(__file__).resolve().parents[2];G=R/'geometry/v5';rig=bpy.data.objects['Production49'];data=json.loads((G/'deformation-authoring-source.json').read_text())
BOOT_ONLY='--boot-only' in sys.argv
meshes=['niko-body','niko-jersey','niko-socks'];old_objects=set(bpy.data.objects)
if not BOOT_ONLY:
 with bpy.data.libraries.load(str(G/'Player_Deformation.blend'),link=False) as (source,target):target.meshes=[n+'_Data' for n in meshes]
 for name,newmesh in zip(meshes,target.meshes):
  ob=bpy.data.objects[name];assert [g.name for g in ob.vertex_groups]==[b['name'] for b in json.loads((R/'verified-source/bridge/assembled-niko-bind.json').read_text())['rig']['bones']]
  ob.data=newmesh
  expected_groups=[b['name'] for b in json.loads((R/'verified-source/bridge/assembled-niko-bind.json').read_text())['rig']['bones']]
  if [g.name for g in ob.vertex_groups]!=expected_groups:
   ob.vertex_groups.clear()
   for groupname in expected_groups:ob.vertex_groups.new(name=groupname)
  assert [g.name for g in ob.vertex_groups]==expected_groups
  assert all(abs(sum(g.weight for g in v.groups)-1)<1e-6 for v in newmesh.vertices),(name,'postmerge actualskinweights')
  if newmesh.shape_keys and newmesh.shape_keys.animation_data:
   for curve in newmesh.shape_keys.animation_data.drivers:
    for var in curve.driver.variables:
     for t in var.targets:
      if t.id and t.id.type=='ARMATURE':t.id=rig
 for meta in data['semanticDrivers']:
  prop=meta['property'];rig[prop]=0.;f=rig.driver_add('["'+prop+'"]');f.driver.type='SCRIPTED';f.driver.expression=meta['expression']
  for name,index in [('qw',0),('qx',1),('qy',2),('qz',3)]:
   v=f.driver.variables.new();v.name=name;v.type='SINGLE_PROP';v.targets[0].id=rig;v.targets[0].data_path=f'pose.bones["{meta["bone"]}"].rotation_quaternion[{index}]'
  assert f.driver.is_simple_expression,(prop,f.driver.expression)
 # Unlinked library dependencies are not visible and no longer own the drivers.
 for ob in set(bpy.data.objects)-old_objects:
  if not ob.users_collection and ob.type=='ARMATURE':bpy.data.objects.remove(ob)

# Preserve accepted source CPU boot deformation in exactly its frozen jog context.
# This is reference adapter data, separate from the NEW body/garment authoring.
boot_source=R/'runtime-assessment/boot-reference/jog-context-boot-flex.json';bootdata=json.loads(boot_source.read_text());boot=bpy.data.objects['niko-boots']
assert not boot.data.shape_keys or not any(k.name.startswith('PRESERVED_JOG_BOOT_') for k in boot.data.shape_keys.key_blocks), 'Merge requires clean motioncore, not an already combined241boot asset'
def decode(a):
 v=array.array('f');v.frombytes(base64.b64decode(a['dataBase64']));return v
neutral=decode(bootdata['neutral']['position']);basis=boot.data.shape_keys.key_blocks[0] if boot.data.shape_keys else boot.shape_key_add(name='Basis',from_mix=False)
base=array.array('f',[0])*(len(basis.data)*3);basis.data.foreach_get('co',base)
assert max(abs(base[i*3+c]-[neutral[i*3],-neutral[i*3+2],neutral[i*3+1]][c]) for i in range(len(basis.data)) for c in range(3))<1e-6
if 'JogPhase' not in rig:rig['JogPhase']=0.
if 'JogContextEnabled' not in rig:rig['JogContextEnabled']=0.
samples=bootdata['samples']
for index,sample in enumerate(samples):
 phase=sample['phase'];delta=decode(sample['positionDelta']);positions=array.array('f',base)
 for i in range(len(basis.data)):
  positions[i*3]+=delta[i*3];positions[i*3+1]-=delta[i*3+2];positions[i*3+2]+=delta[i*3+1]
 key=boot.shape_key_add(name=f'PRESERVED_JOG_BOOT_{index:03d}',from_mix=False);key.data.foreach_set('co',positions);key.value=0
 if index==0:expr=f'ctx*max(0,min(1,({samples[1]["phase"]:.12f}-p)/({samples[1]["phase"]:.12f})))'
 elif index==len(samples)-1:expr=f'ctx*max(0,min(1,(p-{samples[-2]["phase"]:.12f})/(1-{samples[-2]["phase"]:.12f})))'
 else:
  prev=samples[index-1]['phase'];nxt=samples[index+1]['phase'];expr=f'ctx*max(0,min(1,(p-{prev:.12f})/{phase-prev:.12f},({nxt:.12f}-p)/{nxt-phase:.12f}))'
 f=key.driver_add('value');f.driver.type='SCRIPTED';f.driver.expression=expr
 for name,prop in [('p','JogPhase'),('ctx','JogContextEnabled')]:
  v=f.driver.variables.new();v.name=name;v.type='SINGLE_PROP';v.targets[0].id=rig;v.targets[0].data_path='["'+prop+'"]'
 assert f.driver.is_simple_expression,(index,expr)
boot.data.shape_keys['adapterScope']='PRESERVED accepteda278 CPU bootflex sampled at241 frozen supported-jog phases; gated JogContextEnabled for BOTH paired jogs. No universalpitch claim/no ballfit/no73.156mmfollowthrough repair; source normals retained separately.'
boot.data.shape_keys['sourceSHA256']=hashlib.sha256(boot_source.read_bytes()).hexdigest()
spec=importlib.util.spec_from_file_location('floatphase',str(R/'motion/repair-jog-phase-type.py'));phase_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(phase_module);phase_report=phase_module.repair_jog_phase_property(rig)
(G/'validation'/('merged-phase-before.json' if BOOT_ONLY else 'merged-phase-after.json')).write_text(json.dumps(phase_report,indent=2)+'\n')
spec=importlib.util.spec_from_file_location('contextguard',str(R/'motion/guard-jog-context.py'));guard_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard_module);guard_report=guard_module.apply_jog_context_guards(rig)
(G/'validation'/('context-guard-before.json' if BOOT_ONLY else 'context-guard-after.json')).write_text(json.dumps(guard_report,indent=2)+'\n')
# Purposeful tracked native authoring view; camera never drives the actor.
wrap=bpy.data.objects['REFERENCE_JOG_ROOT_TRAJECTORY_2p4mps'];cam=bpy.context.scene.camera;cam.parent=wrap;cam.matrix_parent_inverse=Matrix.Identity(4);cam.location=(3,-4,1.2);cam.rotation_euler=((__import__('mathutils').Vector((0,0,.95)))-cam.location).to_track_quat('-Z','Y').to_euler()
for screen in bpy.data.screens:
 for area in screen.areas:
  if area.type=='VIEW_3D':area.spaces.active.region_3d.view_perspective='CAMERA'
bpy.context.scene['R11_AuthoredSourceMode']=('Baseline R10 geometry unchanged, preserved jog CPUbootadapter only; no new guide keys.' if BOOT_ONLY else 'New collar/cuff/sock geometry+sourceweights+native shoulder/knee guidecorrectives and bounded5.5mm frontpanel ease; baseline sampled formulas muted. Preserved source CPUbootadapter gated only validatedjogcontext. No artist/realism acceptance yet.')
bpy.context.scene.frame_set(1);bpy.context.view_layer.update()
spec=importlib.util.spec_from_file_location('dedupimages',str(R/'geometry/deduplicate-native-images.py'));dedup_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(dedup_module);image_report=dedup_module.deduplicate_native_images(authored=not BOOT_ONLY)
(G/'validation'/('image-dedup-before.json' if BOOT_ONLY else 'image-dedup-after.json')).write_text(json.dumps(image_report,indent=2)+'\n')
# Saved preview-only ground: no effect on actor geometry, rig, targets or clocks.
if 'JOG_PROOF_GROUND' not in bpy.data.objects:
 collection=bpy.data.collections.get('R11_DIAGNOSTIC_PREVIEW') or bpy.data.collections.new('R11_DIAGNOSTIC_PREVIEW')
 if collection.name not in bpy.context.scene.collection.children:bpy.context.scene.collection.children.link(collection)
 groundmesh=bpy.data.meshes.new('JOG_PROOF_GROUND_MESH');groundmesh.from_pydata([(-30,-30,0),(30,-30,0),(30,30,0),(-30,30,0)],[],[(0,1,2),(0,2,3)])
 ground=bpy.data.objects.new('JOG_PROOF_GROUND',groundmesh);collection.objects.link(ground);ground['scope']='Native diagnostic preview ground only; 2 triangles outside actor budgets, no collisions or targets.'
 mat=bpy.data.materials.new('JOG_PROOF_GROUND_MATERIAL');mat.diffuse_color=(.045,.06,.065,1);mat.use_nodes=True;bs=mat.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(.045,.06,.065,1);bs.inputs['Roughness'].default_value=.9;groundmesh.materials.append(mat)
out=G/('Player_Before_BootAdapter.blend' if BOOT_ONLY else 'Player_Combined.blend');bpy.ops.wm.save_as_mainfile(filepath=str(out),compress=True)
print(json.dumps({'out':str(out),'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'bytes':out.stat().st_size,'newGuideKeys':0 if BOOT_ONLY else len(data['correctives']),'preservedBootKeys':len(samples),'scope':'Provisional native visualgate, notruntime or finalvisualacceptance'}))
