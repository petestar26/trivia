"""Original bounded front-panel source ease. No skin mask/weights/rig change."""
import bpy,json,math,hashlib
from pathlib import Path
from mathutils import Vector,Matrix
R=Path(__file__).resolve().parents[2];G=R/'geometry';O=G/'v5';ob=bpy.data.objects['niko-jersey'];mesh=ob.data;src=json.loads((G/'deformation-authoring-source.json').read_text());C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)));CI=C.inverted();basis=mesh.shape_keys.key_blocks[0];old=[v.co.copy() for v in basis.data];cuff=set(src['jerseyWeightControls']['explicitCuffVertices']);oldnormals=[x.vector.copy() for x in mesh.corner_normals]
def sm(a,b,x):
 t=max(0,min(1,(x-a)/(b-a)));return t*t*(3-2*t)
rows=[];selected=set()
for i,native in enumerate(old):
 p=CI@native
 if i in cuff:continue
 w=sm(.075,.100,abs(p.x))*(1-sm(.150,.180,abs(p.x)))*sm(1.12,1.17,p.y)*(1-sm(1.25,1.30,p.y))*sm(.06,.10,p.z)
 dz=.0055*w
 if dz<1e-9:continue
 delta=C.to_3x3()@Vector((0,0,dz));selected.add(i)
 for key in mesh.shape_keys.key_blocks:key.data[i].co+=delta
 mesh.vertices[i].co=basis.data[i].co
 rows.append({'vertex':i,'deltaRuntimeMetres':[0,0,dz],'sourceRuntimePosition':list(p),'fieldWeight':w})
assert rows and max(x['deltaRuntimeMetres'][2] for x in rows)<=.005500001
assert not selected.intersection(cuff)
mesh.update()
# Update source-normal presentation only on the changed front patch and immediate
# mesh neighbors. Request old decoded normals elsewhere; Blender re-encoding
# can quantize those values, measured and explicitly bounded in the manifest.
normalvertices=set(selected)
for poly in mesh.polygons:
 if any(i in selected for i in poly.vertices):normalvertices.update(poly.vertices)
keys=[tuple(round(x,6) for x in v) for v in old];area={}
for poly in mesh.polygons:
 ids=list(poly.vertices)
 for j in range(1,len(ids)-1):
  tri=[ids[0],ids[j],ids[j+1]];a,b,c=[basis.data[k].co for k in tri];n=(b-a).cross(c-a)
  for i in tri:area[keys[i]]=area.get(keys[i],Vector())+n
newnormals=[]
for loop in mesh.loops:
 i=loop.vertex_index;n=area[keys[i]].normalized() if i in normalvertices else oldnormals[loop.index];newnormals.append(n)
mesh.normals_split_custom_set(newnormals)
# Full old-source→new-source delta list keeps strict R10 reconstruction valid.
edits={x['vertex']:list(x['deltaRuntimeMetres']) for x in src['neutralEdits']['niko-jersey']}
for row in rows:
 v=edits.setdefault(row['vertex'],[0,0,0])
 for axis in range(3):v[axis]+=row['deltaRuntimeMetres'][axis]
src['neutralEdits']['niko-jersey']=[{'vertex':i,'deltaRuntimeMetres':d} for i,d in sorted(edits.items())]
src['frontPanelEaseV5']={'authorship':'Original deliberate numerical source tailoring, not artist sculpt or collision-target motion','parentNativeSHA256':'a7d496c22dea5775c5f53318e795a44884b3869fd0e4004060e53055636947fc','parentGeometrySourceSHA256':hashlib.sha256((G/'deformation-authoring-source.json').read_bytes()).hexdigest(),'maximumEaseMetres':.0055,'support':{'absX':[.075,.100,.150,.180],'runtimeY':[1.12,1.17,1.25,1.30],'frontZRamp':[.06,.10]},'excludedSourceCuffVertices':sorted(cuff),'rows':rows,'normalVertices':sorted(normalvertices),'normalPolicy':'Only changed-front patch and immediate source neighbors request recalculated area normals; old decoded normals requested elsewhere. Blender basis-dependent custom-normal encoding can re-quantize those values (measured max vector change0.000330151; explicit bound0.0005). Other meshes and semantic runtime_normal channels remain unchanged/historical reference.','unchanged':['jerseyUV/indices/weights','all other7actorMeshData','eightfacechannels','49rigrest/inverse/contact/root/clocks','bodymask','allkeydeltasrelativebasis']}
src['frontPanelEaseV5']['unrelatedDecodedNormalVectorTolerance']=.0005
mesh['R11FrontPanelEaseV5']='Source front torso5.5mm bounded ease. No body deletion, no movement target changes.'
(O/'deformation-authoring-source.json').write_text(json.dumps(src,indent=2)+'\n');out=O/'Player_Deformation.blend';bpy.ops.wm.save_as_mainfile(filepath=str(out),compress=True)
print(json.dumps({'output':str(out),'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'editedVertices':len(rows),'maxMetres':max(x['deltaRuntimeMetres'][2] for x in rows)}))
