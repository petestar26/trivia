"""Focused source-delta assertions on V5, independent readback after reopen."""
import bpy,json,hashlib,math
from pathlib import Path
from mathutils import Matrix,Vector
R=Path(__file__).resolve().parents[2];G=R/'geometry';O=G/'v5';j=bpy.data.objects['niko-jersey'];source=json.loads((O/'deformation-authoring-source.json').read_text());patch=source['frontPanelEaseV5'];C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)));rows={x['vertex']:C.to_3x3()@Vector(x['deltaRuntimeMetres']) for x in patch['rows']};normset=set(patch['normalVertices']);meshnames=[o.data.name for o in bpy.data.objects if o.type=='MESH' and o.name.startswith('niko-')]
current={o.name:o for o in bpy.data.objects if o.type=='MESH' and o.name.startswith('niko-')}
with bpy.data.libraries.load(str(G/'Player_Deformation.blend'),link=False) as (s,t):t.meshes=meshnames
baseline={n:m for n,m in zip(list(current),t.meshes)};out={'scope':'Focused native source-delta readback, not visual/browser acceptance','inputSHA256':hashlib.sha256(Path(bpy.data.filepath).read_bytes()).hexdigest(),'checks':[]}
def check(name,condition,detail=None):
 out['checks'].append({'name':name,'pass':bool(condition),'detail':detail});assert condition,(name,detail)
for name,ob in current.items():
 a=ob.data;b=baseline[name];check(name+'vertexcount',len(a.vertices)==len(b.vertices));check(name+'indices',[[*p.vertices] for p in a.polygons]==[[*p.vertices] for p in b.polygons]);check(name+'UV',max((abs(x-y) for la,lb in zip(a.uv_layers,b.uv_layers) for va,vb in zip(la.data,lb.data) for x,y in zip(va.uv,vb.uv)),default=0)==0)
 expectedkeys=[x.name for x in b.shape_keys.key_blocks] if b.shape_keys else [];check(name+'keynames',([x.name for x in a.shape_keys.key_blocks] if a.shape_keys else [])==expectedkeys)
 if a.shape_keys:
  err=max(((va.co-vb.co-rows.get(i,Vector()) if name=='niko-jersey' else va.co-vb.co).length for ka,kb in zip(a.shape_keys.key_blocks,b.shape_keys.key_blocks) for i,(va,vb) in enumerate(zip(ka.data,kb.data))),default=0);check(name+'allkeyexactdeclaredoffset',err<2e-7,err)
 else:
  err=max(((va.co-vb.co).length for va,vb in zip(a.vertices,b.vertices)),default=0);check(name+'unchangedpositions',err==0,err)
 wa=[[(g.group,g.weight) for g in v.groups] for v in a.vertices];wb=[[(g.group,g.weight) for g in v.groups] for v in b.vertices];check(name+'skinweights',wa==wb)
 if name=='niko-jersey':
  check('noCuffEdits',not set(rows).intersection(patch['excludedSourceCuffVertices']));check('5p5mmCap',max(v.length for v in rows.values())<=.005500001);unchanged=max(((a.corner_normals[l.index].vector-b.corner_normals[l.index].vector).length for l in a.loops if l.vertex_index not in normset),default=0);check('unrelatedCustomNormalsQuantizationBound',unchanged<patch['unrelatedDecodedNormalVectorTolerance'],unchanged)
 else:check(name+'cornernormals',max(((x.vector-y.vector).length for x,y in zip(a.corner_normals,b.corner_normals)),default=0)==0)
check('only122sourcepoints',len(rows)==122);check('noboundaryTopologyChange',len(j.data.vertices)==1794);check('finiteUnitNativeNormals',all(math.isfinite(n.vector.length) and abs(n.vector.length-1)<3e-6 for n in j.data.corner_normals));out['status']='PASS';(O/'validation/focused-front-ease.json').write_text(json.dumps(out,indent=2)+'\n');print('FOCUSED_FRONT_EASE_PASS',len(out['checks']))
