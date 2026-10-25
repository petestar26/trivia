"""Original source-fitted sock topology and explicit body-surface pose shapes.
No runtime collision/target algorithm. Body triangle+barycentric controls remain
editable/provenanced; native keys are baked from this deliberate source fit.
"""
import bpy,bmesh,array,base64,json,math,struct
from mathutils import Matrix,Vector,geometry
from mathutils.bvhtree import BVHTree
C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)));CI=C.inverted()
ROWS=[.465,.460,.445,.439,.417,.400,.330,.240,.150,.105,.101]
OLD_ROWS=[0,1,2,3,None,4,5,6,7,8,9]
EASE=[.006,.0075,.0075,.006,.006,.006,.005,.004,.004,0,0]
BANDS=[(.405,1),(.44,.94),(.47,.72),(.50,.44),(.53,.22),(.56,.07),(.595,0)]
def smooth(a,b,x):
 t=max(0,min(1,(x-a)/(b-a)));return t*t*(3-2*t)
def distal(v):
 if v.y<=.405:return 1.
 if v.y>=.595:return 0.
 for (a,wa),(b,wb) in zip(BANDS,BANDS[1:]):
  if a<=v.y<=b:w=wa+(wb-wa)*smooth(a,b,v.y);break
 return max(0,min(1,w-.14*smooth(.005,.06,v.z)*(1-min(1,abs(v.y-.5)/.095)**2)))
def raw_triangles(path):
 b=path.read_bytes();n=struct.unpack_from('<I',b,12)[0];g=json.loads(b[20:20+n]);startbin=20+n+8;a=g['accessors'][g['meshes'][0]['primitives'][0]['indices']];view=g['bufferViews'][a['bufferView']];v=array.array({5123:'H',5125:'I'}[a['componentType']]);start=startbin+view.get('byteOffset',0)+a.get('byteOffset',0);v.frombytes(b[start:start+a['count']*v.itemsize]);return [list(v[i:i+3]) for i in range(0,len(v),3)]
_SECTIONS={}
def section_radius(points,tris,y,sign,theta):
 center=Vector((sign*.1,-.015));d=Vector((math.cos(theta),math.sin(theta)));key=(id(points),y,sign)
 if key not in _SECTIONS:
  segments=[]
  for tri in tris:
   if any(sign*points[i].x<0 for i in tri):continue
   vs=[points[i] for i in tri]
   if min(v.y for v in vs)>y or max(v.y for v in vs)<y:continue
   cuts=[]
   for a,b in zip(vs,[vs[1],vs[2],vs[0]]):
    if (a.y<=y<b.y) or (b.y<=y<a.y):
     t=(y-a.y)/(b.y-a.y);p=a+(b-a)*t;cuts.append(Vector((p.x,p.z)))
   if len(cuts)==2:segments.append(cuts)
  _SECTIONS[key]=segments
 hits=[]
 for a,b in _SECTIONS[key]:
  v=b-a;den=d.x*v.y-d.y*v.x
  if abs(den)<1e-10:continue
  q=a-center;t=(q.x*v.y-q.y*v.x)/den;u=(q.x*d.y-q.y*d.x)/den
  if t>0 and -.00001<=u<=1.00001:hits.append(t)
 assert hits,('missingbodysection',y,sign,theta)
 return max(hits)

def lowpass(values,harmonics=5):
 n=len(values);mean=sum(values)/n;out=[]
 for j in range(n):
  value=mean
  for k in range(1,harmonics+1):
   ac=2*sum(x*math.cos(2*math.pi*k*i/n) for i,x in enumerate(values))/n;bs=2*sum(x*math.sin(2*math.pi*k*i/n) for i,x in enumerate(values))/n
   value+=ac*math.cos(2*math.pi*k*j/n)+bs*math.sin(2*math.pi*k*j/n)
  out.append(value)
 return out

def build_source(ob,body,rawpath,record,replace_weights):
 oldmesh=ob.data;group_names=[g.name for g in ob.vertex_groups];oldpos=[CI@v.co for v in (oldmesh.shape_keys.key_blocks[0].data if oldmesh.shape_keys else oldmesh.vertices)];oldw=[{ob.vertex_groups[g.group].name:g.weight for g in v.groups} for v in oldmesh.vertices];color=list(oldmesh.color_attributes['RuntimePreviewColor'].data[0].color);mats=list(oldmesh.materials)
 # Preserve exact source attributes and native shader aliases through topology edit.
 point_attributes=[]
 fields={'FLOAT':('value',1),'INT':('value',1),'BOOLEAN':('value',1),'FLOAT_VECTOR':('vector',3),'FLOAT2':('vector',2),'FLOAT_COLOR':('color',4),'BYTE_COLOR':('color',4)}
 for a in oldmesh.attributes:
  if a.domain!='POINT' or a.name=='position' or a.name.startswith('.') or a.data_type not in fields:continue
  field,width=fields[a.data_type];values=[]
  for x in a.data:
   v=getattr(x,field);values.append(list(v) if width>1 else [v])
  point_attributes.append((a.name,a.data_type,field,width,values))
 source_uv={}
 for layer in oldmesh.uv_layers:
  values=[None]*len(oldpos)
  for loop in oldmesh.loops:
   v=list(layer.data[loop.index].uv)
   assert values[loop.vertex_index] is None or max(abs(x-y) for x,y in zip(values[loop.vertex_index],v))<1e-6,('UVsplit source ambiguity',layer.name,loop.vertex_index)
   values[loop.vertex_index]=v
  assert all(v is not None for v in values),('unreferenced sourceUV',layer.name)
  source_uv[layer.name]=values
 pts=[CI@v.co for v in body.data.shape_keys.key_blocks[0].data];tris=raw_triangles(rawpath)
 positions=[];uv=[];weights=[];mapping=[];newrecords=[]
 for side,sign,oldbase in [('L',1,0),('R',-1,330)]:
  base=len(positions)
  for row,y in enumerate(ROWS):
   oldrow=OLD_ROWS[row]
   radii=lowpass([section_radius(pts,tris,y,sign,2*math.pi*j/32) for j in range(32)]) if row<9 else None
   for j in range(33):
    theta=2*math.pi*j/32
    if row>=9:
     source=oldbase+oldrow*33+j;p=oldpos[source].copy();w=oldw[source].copy()
    else:
     radius=radii[j%32]+EASE[row];p=Vector((sign*.1+radius*math.cos(theta),y,-.015+radius*math.sin(theta)));d=distal(p);w={'upperLeg'+side:1-d,'lowerLeg'+side:d}
    index=len(positions);positions.append(p);weights.append(w)
    if oldrow is not None:
     source=oldbase+oldrow*33+j;mapping.append([source,index]);v=oldrow/9
    else:
     t=(ROWS[3]-y)/(ROWS[3]-ROWS[5]);v=(3+t)/9;newrecords.append({'vertex':index,'uvParentOriginalVertices':[oldbase+3*33+j,oldbase+4*33+j],'uvParentWeights':[1-t,t]})
    uv.append((j/32,v))
  assert len(positions)-base==363
 faces=[]
 for base in [0,363]:
  for r in range(10):
   for j in range(32):
    a=base+r*33+j;b=a+33;faces.extend([(a,a+1,b),(b,a+1,b+1)])
 mesh=bpy.data.meshes.new('R11_SOCK_SOURCE_NEW');mesh.from_pydata([C@p for p in positions],[],faces);mesh.update()
 oldmesh.name='R10_SOCKS_REFERENCE_DATA';oldmesh.use_fake_user=True;ob.data=mesh;mesh.name='niko-socks_Data'
 ob.vertex_groups.clear()
 for name in group_names:ob.vertex_groups.new(name=name)
 for mat in mats:mesh.materials.append(mat)
 # Every original vertex survives. New row is linearly interpolated from exact
 # original source attributes/UVs, including named native material aliases.
 parents={new:([old],[1.]) for old,new in mapping}
 for rec in newrecords:parents[rec['vertex']]=(rec['uvParentOriginalVertices'],rec['uvParentWeights'])
 def remap(values,integer=False):
  output=[]
  for i in range(len(positions)):
   ids,ws=parents[i]
   if integer:output.append(values[ids[ws.index(max(ws))]])
   else:output.append([sum(values[j][c]*w for j,w in zip(ids,ws)) for c in range(len(values[0]))])
  return output
 uv_mapped={}
 for name,values in source_uv.items():
  mapped=remap(values);uv_mapped[name]=mapped;layer=mesh.uv_layers.new(name=name);layer.data.foreach_set('uv',[v for loop in mesh.loops for v in mapped[loop.vertex_index]])
 uv=uv_mapped['uv']
 attribute_records=[]
 for name,kind,field,width,values in point_attributes:
  mapped=remap(values,kind in ['INT','BOOLEAN'])
  a=mesh.attributes.get(name) or mesh.attributes.new(name=name,type=kind,domain='POINT')
  if width==1:
   for x,v in zip(a.data,mapped):setattr(x,field,v[0])
  else:a.data.foreach_set(field,[v for row in mapped for v in row])
  attribute_records.append({'name':name,'dataType':kind,'domain':'POINT','values':mapped})
 assert all(name in mesh.attributes for name,kind,field,width,values in point_attributes), 'original source point attribute lost'
 assert all(name in mesh.uv_layers for name in source_uv), 'original source UV layer lost'
 assert group_names==[b['name'] for b in json.loads((rawpath.parents[1]/'assembled-niko-bind.json').read_text())['rig']['bones']], 'canonical49 group order changed'
 for f in mesh.polygons:f.use_smooth=True
 replace_weights(ob,{i:w for i,w in enumerate(weights)})
 # Shared area normals across duplicated UV corners, including bothleg seams.
 normal={};keys=[tuple(round(v,7) for v in p) for p in positions]
 for tri in faces:
  a,b,c=[C@positions[i] for i in tri];n=(b-a).cross(c-a)
  for i in tri:normal[keys[i]]=normal.get(keys[i],Vector())+n
 mesh.normals_split_custom_set_from_vertices([normal[k].normalized() for k in keys])
 ob.shape_key_add(name='Basis',from_mix=False)
 record['sockTopology']={'canonicalVertexGroupOrder':group_names,'sourceOldVertexCount':660,'newVertexCount':726,'newTriangleCount':1280,'rowsY':ROWS,'rowOriginalIndices':OLD_ROWS,'originalVertexMap':mapping,'newVertices':newrecords,'protectedOriginalRows':[8,9],'neutralPositionsRuntimeMetres':[list(p) for p in positions],'uvPerVertex':[list(v) for v in uv],'uvLayersPerVertex':uv_mapped,'pointAttributes':attribute_records,'indices':[i for tri in faces for i in tri],'expectedWeights':weights,'fit':'Same-side anatomical horizontal bodysections, explicit5harmonic radialcontrols+4–7.5mm ease; extra.417ringfitsactual8725/3638calfpeak. No skinface deletion.','sourceBodyTriangleBindings':'See sockSurfaceBindings, usedfornew60/120nativekeys','normalPolicy':'runtime_normal remains an exact mapped/interpolated historical source reference attribute; native geometric/custom normals are recomputed for newly fitted topology, not claimed equal to old runtime normals.','legacyContributions':'OldfourBASELINE_SAMPLEDsockkeys replaced; originalR10MeshData retainedasnonrenderedreference, immutablepackagepreserved.'}
 return positions,tris

def build_pose_keys(ob,body,rig,positions,tris,record,bone_rest,rot,bind_mix,driver):
 native_rest=[v.co.copy() for v in body.data.shape_keys.key_blocks[0].data];bindings={}
 for side,sign,base in [('L',1,0),('R',-1,363)]:
  filtered=[t for t in tris if all(sign*(CI@native_rest[i]).x>0 for i in t) and min((CI@native_rest[i]).y for i in t)>.36 and max((CI@native_rest[i]).y for i in t)<.62]
  tree=BVHTree.FromPolygons(native_rest,filtered,all_triangles=True)
  for row in range(6):
   for j in range(33):
    i=base+row*33+j;p=C@positions[i];hit,n,face,d=tree.find_nearest(p);tri=filtered[face];a,b,c=[native_rest[k] for k in tri];bc=geometry.barycentric_transform(hit,a,b,c,Vector((1,0,0)),Vector((0,1,0)),Vector((0,0,1)))
    bindings[i]={'vertex':i,'side':side,'bodyTriangle':tri,'barycentric':list(bc),'easeMetres':EASE[row],'neutralNearestDistanceMetres':d}
 record['sockSurfaceBindings']=list(bindings.values())
 for side,sign in [('L',1),('R',-1)]:
  for degrees in [60,120]:
   angle=math.radians(degrees);bone_rest();rot('lowerLeg'+side,(1,0,0),angle);bpy.context.view_layer.update();ev=body.evaluated_get(bpy.context.evaluated_depsgraph_get());bm=ev.to_mesh();posed=[v.co.copy() for v in bm.vertices];ev.to_mesh_clear()
   basis=ob.data.shape_keys.key_blocks[0];key=ob.shape_key_add(name=f'R11_SockBodyFit_{side}_{degrees}',from_mix=False);deltas=[]
   for i,v in enumerate(basis.data):
    info=bindings.get(i)
    if not info or info['side']!=side:key.data[i].co=v.co;continue
    tri=info['bodyTriangle'];w=info['barycentric'];a,b,c=[posed[k] for k in tri];point=a*w[0]+b*w[1]+c*w[2];n=(b-a).cross(c-a).normalized()
    ar,br,cr=[native_rest[k] for k in tri];nr=(br-ar).cross(cr-ar).normalized();expected=bind_mix(body,tri[0]).to_3x3().inverted_safe().transposed()@nr
    if n.dot(expected)<0:n=-n
    desired=point+n*info['easeMetres'];mix=bind_mix(ob,i);delta=mix.inverted_safe()@desired-v.co
    assert delta.length<.065,(side,degrees,i,'unexpectedbodyfitdelta',delta.length)
    key.data[i].co=v.co+delta
    if delta.length>1e-8:deltas.append({'vertex':i,'deltaNative':list(delta)})
   key.value=0;driver(key,'knee',side,angle,math.radians(120 if degrees==60 else 60))
   record['correctives'].append({'mesh':ob.name,'name':key.name,'kind':'sock_body_fit','side':side,'angleRadians':angle,'source':'New sourcebody-triangle+barycentric guide with outward6–7.5mmoffset; no nearestthigh search/no genericfairing','maximumBindDeltaMetres':max((Vector(x['deltaNative']).length for x in deltas),default=0),'deltas':deltas})
