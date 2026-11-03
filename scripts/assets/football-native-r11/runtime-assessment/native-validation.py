"""Independent read-only Blender reopen checks. Never writes/saves the input blend.

Run with --background --factory-startup --disable-autoexec --python THIS --
  --blend MERGED.blend --out REPORT.json [--geometry SOURCE.json] [--motion CONTROLS.json]
The report is structural/semantic evidence; it is not native visual acceptance.
"""
import argparse,array,base64,collections,hashlib,json,math,sys,traceback
from pathlib import Path
import bpy
from mathutils import Matrix,Quaternion,Vector
from mathutils.bvhtree import BVHTree

ap=argparse.ArgumentParser();ap.add_argument('--blend',type=Path,required=True);ap.add_argument('--out',type=Path,required=True)
ap.add_argument('--geometry',type=Path);ap.add_argument('--motion',type=Path)
args=ap.parse_args(sys.argv[sys.argv.index('--')+1:]);args.blend=args.blend.resolve()
ROOT=Path(__file__).resolve().parents[1];BRIDGE=ROOT/'verified-source/bridge/assembled-niko-bind.json'
source=json.loads(BRIDGE.read_bytes());geometry_bytes=args.geometry.read_bytes() if args.geometry else None;motion_bytes=args.motion.read_bytes() if args.motion else None
expected_geo=json.loads(geometry_bytes) if geometry_bytes else None;motion=json.loads(motion_bytes) if motion_bytes else None
C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)));CI=C.inverted();CQ=C.to_quaternion()
report={'status':'RUNNING','scope':'Independent read-only native reopen structure/driver checks; not visual, runtime, performance, or device acceptance','blender':bpy.app.version_string,'input':str(args.blend),'inputSHA256':hashlib.sha256(args.blend.read_bytes()).hexdigest(),'bridgeSHA256':hashlib.sha256(BRIDGE.read_bytes()).hexdigest(),'checks':[],'failures':[]}
report['validatorSHA256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
args.out.parent.mkdir(parents=True,exist_ok=True)
if geometry_bytes:
    report['geometryManifestSHA256']=hashlib.sha256(geometry_bytes).hexdigest();p=args.out.with_name(args.out.stem+'-geometry-input.json');p.write_bytes(geometry_bytes);report['geometryManifestSnapshot']=str(p)
if motion_bytes:
    report['motionManifestSHA256']=hashlib.sha256(motion_bytes).hexdigest();p=args.out.with_name(args.out.stem+'-motion-input.json');p.write_bytes(motion_bytes);report['motionManifestSnapshot']=str(p)

def check(name,condition,detail=None):
    record={'name':name,'pass':bool(condition)}
    if detail is not None:record['detail']=detail
    report['checks'].append(record)
    if not condition:report['failures'].append(record)

def decode(a):
    kind={'Float32Array':'f','Float64Array':'d','Uint32Array':'I','Uint16Array':'H','Uint8Array':'B'}[a['typedArray']]
    values=array.array(kind);values.frombytes(base64.b64decode(a['dataBase64']))
    if sys.byteorder!='little':values.byteswap()
    return values

def matrix(values):return Matrix(tuple(tuple(values[col*4+row] for col in range(4)) for row in range(4)))
def difference(a,b):return max(abs(a[r][c]-b[r][c]) for r in range(4) for c in range(4))
def encoded(values,item_size,kind='Float32Array'):
    a=array.array('I' if kind=='Uint32Array' else 'f',values)
    return {'typedArray':kind,'itemSize':item_size,'count':len(a)//item_size,'dataBase64':base64.b64encode(a.tobytes()).decode()}
def expected_mesh(m):
    top=(expected_geo or {}).get('sockTopology')
    if m['name']!='niko-socks' or not top:return m
    attrs=dict(m['attributes']);attrs['position']=encoded([v for p in top['neutralPositionsRuntimeMetres'] for v in p],3)
    for name,values in top.get('uvLayersPerVertex',{'uv':top['uvPerVertex']}).items():attrs[name]=encoded([v for p in values for v in p],2)
    order=[b['name'] for b in source['rig']['bones']];indices=[];weights=[]
    for row in top['expectedWeights']:
        terms=[(order.index(n),w) for n,w in row.items() if w>0];terms+=([(0,0)]*(4-len(terms)));indices.extend(i for i,w in terms);weights.extend(w for i,w in terms)
    attrs['skinIndex']=encoded(indices,4,'Uint32Array');attrs['skinWeight']=encoded(weights,4)
    return {**m,'attributes':attrs,'index':encoded(top['indices'],1,'Uint32Array'),'_declaredSockTopology':True}
def attribute_value(item):
    if hasattr(item,'color'):return list(item.color)
    if hasattr(item,'vector'):return list(item.vector)
    value=item.value;return list(value) if hasattr(value,'__len__') else [value]
native_baseline_attributes={}
def capture_native_baseline_attributes():
    if not(expected_geo and expected_geo.get('sockTopology')):return
    path=ROOT/'verified-source/native/PlayQube_ReviewPlayer_Baseline.blend';bpy.ops.wm.open_mainfile(filepath=str(path),load_ui=False,use_scripts=False)
    for m in source['meshes']:
        mesh=bpy.data.objects[m['name']].data;attrs={}
        for a in mesh.attributes:
            # Blender's compressed custom_normal is a topology/basis-dependent INT16_2D stream,
            # not an original shader attribute. Real geometric normals are recomputed; the
            # distinct runtime_normal historical source alias remains checked verbatim.
            if a.name.startswith('.') or a.name in ['position','custom_normal'] or a.domain not in ['POINT','CORNER']:continue
            values=[None]*len(mesh.vertices);consistent=True
            for i,item in enumerate(a.data):
                vertex=i if a.domain=='POINT' else mesh.loops[i].vertex_index;v=attribute_value(item)
                if values[vertex] is not None and max(abs(x-y) for x,y in zip(values[vertex],v))>1e-7:consistent=False
                values[vertex]=v
            if a.name in m['attributes'] and m['attributes'][a.name]['count']==len(values):
                original=decode(m['attributes'][a.name]);size=m['attributes'][a.name]['itemSize']
                for i,v in enumerate(values):
                    if v is None:values[i]=list(original[i*size:i*size+size])
            attrs[a.name]={'domain':a.domain,'type':a.data_type,'values':values,'perVertexConsistent':consistent}
        native_baseline_attributes[m['name']]=attrs
    report['immutableNativeAttributeBaseline']={'file':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'attributeNames':{m:list(v) for m,v in native_baseline_attributes.items()}}
def native_attribute_checks(ob):
    originals=native_baseline_attributes.get(ob.name)
    if originals is None:return
    top=(expected_geo or {}).get('sockTopology') if ob.name=='niko-socks' else None
    mapping={new:[(old,1.)] for old,new in top['originalVertexMap']} if top else {i:[(i,1.)] for i in range(len(ob.data.vertices))}
    if top:
        for r in top['newVertices']:mapping[r['vertex']]=list(zip(r['uvParentOriginalVertices'],r['uvParentWeights']))
    for name,original in originals.items():
        a=ob.data.attributes.get(name);error=0;unresolved=set()
        if a:
            for i,item in enumerate(a.data):
                vertex=i if a.domain=='POINT' else ob.data.loops[i].vertex_index;parents=mapping[vertex]
                if any(original['values'][old] is None for old,w in parents):unresolved.add(vertex);continue
                actual=attribute_value(item);expected=[sum(original['values'][old][j]*w for old,w in parents) for j in range(len(actual))];error=max(error,max(abs(x-y) for x,y in zip(actual,expected)))
        check('native-source-attribute/'+ob.name+'/'+name,a is not None and a.domain==original['domain'] and a.data_type==original['type'] and original['perVertexConsistent'] and error<2e-7 and not unresolved,{'domain':original['domain'],'type':original['type'],'maxMappedOrInterpolatedError':error,'sourcePerVertexConsistent':original['perVertexConsistent'],'unresolvedSourceVertices':sorted(unresolved)[:16]})
def declared_sock_topology_checks(ob):
    top=(expected_geo or {}).get('sockTopology')
    if not top:return
    old=next(m for m in source['meshes'] if m['name']=='niko-socks');mapping=dict(top['originalVertexMap']);new={r['vertex']:r for r in top['newVertices']};names=[b['name'] for b in source['rig']['bones']];all_ids=set(mapping.values())|set(new)
    check('declared-sock-only-topology-contract',top['sourceOldVertexCount']==660 and top['newVertexCount']==726 and top['newTriangleCount']==1280 and set(mapping)==set(range(660)) and len(set(mapping.values()))==660 and len(new)==66 and all_ids==set(range(726)) and not set(mapping.values())&set(new) and top['canonicalVertexGroupOrder']==names,{'oldVertices':660,'newVertices':len(ob.data.vertices),'newTriangles':len(ob.data.polygons),'retainedSourceIDs':len(mapping),'interpolatedVertices':len(new)})
    basis=ob.data.shape_keys.key_blocks[0].data;oldpos=decode(old['attributes']['position']);uv=decode(old['attributes']['uv']);si=decode(old['attributes']['skinIndex']);sw=decode(old['attributes']['skinWeight']);maxpos=0;maxuv=0;maxweight=0
    for base in [0,330]:
        for row in top['protectedOriginalRows']:
            for j in range(33):
                old_id=base+row*33+j;new_id=mapping[old_id];expected=C@Vector(oldpos[old_id*3:old_id*3+3]);maxpos=max(maxpos,(basis[new_id].co-expected).length);maxuv=max(maxuv,max(abs(top['uvPerVertex'][new_id][k]-uv[old_id*2+k]) for k in range(2)));expected_weights={}
                for k in range(4):
                    if sw[old_id*4+k]>0:n=names[si[old_id*4+k]];expected_weights[n]=expected_weights.get(n,0)+sw[old_id*4+k]
                actual={ob.vertex_groups[g.group].name:g.weight for g in ob.data.vertices[new_id].groups if g.weight>0};maxweight=max(maxweight,max(abs(actual.get(n,0)-expected_weights.get(n,0)) for n in set(actual)|set(expected_weights)))
    check('protected-original-sock-ankle-foot-rows',top['protectedOriginalRows']==[8,9] and maxpos==0 and maxuv<3e-8 and maxweight==0,{'originalRows':[8,9],'protectedSourceVertices':132,'maxPositionError':maxpos,'maxUVError':maxuv,'maxWeightError':maxweight})
def co_array(key):
    out=array.array('f',[0])*(len(key.data)*3);key.data.foreach_get('co',out);return out
def oriented(tri):return min(tuple(tri),tuple(tri[1:]+tri[:1]),tuple(tri[2:]+tri[:2]))
def open_input():
    bpy.ops.wm.open_mainfile(filepath=str(args.blend),load_ui=False,use_scripts=False)
    bpy.context.view_layer.update()
    return bpy.data.objects.get('Production49')

def face_weights(label):
    rows={}
    for m in source['meshes']:
        if not m['morphTargetDictionary']:continue
        ob=bpy.data.objects[m['name']];keys=ob.data.shape_keys.key_blocks
        actual={n:keys[n].value for n in m['morphTargetDictionary'] if n in keys}
        expected={n:m['morphTargetInfluences'][i] for n,i in m['morphTargetDictionary'].items()}
        error=max((abs(actual.get(n,1e6)-v) for n,v in expected.items()),default=0)
        check('face-values/'+label+'/'+m['name'],len(actual)==8 and error<1e-7,{'maxError':error,'values':actual})
        rows[m['name']]=actual
    return rows

def dependencies(label):
    libraries=[x.filepath for x in bpy.data.libraries]
    unpacked=[]
    for kind,blocks in [('image',bpy.data.images),('font',bpy.data.fonts),('sound',bpy.data.sounds),('movieclip',bpy.data.movieclips)]:
        for block in blocks:
            path=getattr(block,'filepath','');packed=bool(getattr(block,'packed_file',None)) or bool(getattr(block,'packed_files',[]))
            builtin=not path or path=='<builtin>' or getattr(block,'source',None) in ['GENERATED','VIEWER']
            if not packed and not builtin:unpacked.append({'kind':kind,'name':block.name,'file':path})
    modules=[x.name for x in bpy.data.texts if x.use_module]
    all_drivers=[]
    for owner in [*bpy.data.objects,*bpy.data.shape_keys,*bpy.data.materials,*bpy.data.node_groups]:
        ad=getattr(owner,'animation_data',None)
        if ad:
            for f in ad.drivers:all_drivers.append({'owner':owner.name,'path':f.data_path,'expression':f.driver.expression,'simple':f.driver.is_simple_expression,'valid':f.driver.is_valid})
    actor_images=set()
    for m in source['meshes']:
        for slot in bpy.data.objects[m['name']].material_slots:
            if slot.material and slot.material.use_nodes:
                for node in slot.material.node_tree.nodes:
                    if node.type=='TEX_IMAGE' and node.image:actor_images.add(node.image.name)
    image_budget=[]
    for image in bpy.data.images:
        packed=[p.packed_file for p in image.packed_files] if image.packed_files else ([image.packed_file] if image.packed_file else [])
        image_budget.append({'name':image.name,'source':image.source,'size':list(image.size),'packedBytes':sum(p.size for p in packed),'packedFileSHA256':[hashlib.sha256(bytes(p.data)).hexdigest() for p in packed],'colorSpace':image.colorspace_settings.name,'alphaMode':image.alpha_mode,'channels':image.channels,'isFloat':image.is_float,'fileFormat':image.file_format,'actorMaterialReference':image.name in actor_images})
    duplicates=collections.defaultdict(list)
    for row in image_budget:
        if row['packedBytes']>0:duplicates[json.dumps({k:row[k] for k in ['source','size','packedFileSHA256','colorSpace','alphaMode','channels','isFloat','fileFormat']},sort_keys=True)].append(row['name'])
    check('dependencies/'+label,not libraries and not unpacked and not modules,{'linkedLibraries':libraries,'unpackedExternalData':unpacked,'autoRunTexts':modules,'images':len(bpy.data.images),'packedImageDatablocks':sum(x['packedBytes']>0 for x in image_budget),'totalPackedImageBytes':sum(x['packedBytes'] for x in image_budget),'actorMaterialImageDatablocks':len(actor_images),'exactMetadataAndByteDuplicateGroups':[v for v in duplicates.values() if len(v)>1],'imageBudget':image_budget})
    check('simple-drivers/'+label,all(x['simple'] and x['valid'] for x in all_drivers),{'count':len(all_drivers),'nonSimpleOrInvalid':[x for x in all_drivers if not(x['simple'] and x['valid'])]})
    check('autoexec-disabled/'+label,not bpy.context.preferences.filepaths.use_scripts_auto_execute and not bpy.app.autoexec_fail,{'automaticScriptsEnabled':bpy.context.preferences.filepaths.use_scripts_auto_execute,'autoexecFail':bpy.app.autoexec_fail,'autoexecFailMessage':bpy.app.autoexec_fail_message})

def structural(rig):
    bones=source['rig']['bones'];names=[x['name'] for x in bones]
    check('canonical49-names',rig is not None and len(rig.data.bones)==49 and set(rig.data.bones.keys())==set(names))
    if rig is None:raise RuntimeError('Production49 missing')
    rest_error=0;inverse_error=0;metadata_error=0;parents=[]
    for b in bones:
        bone=rig.data.bones[b['name']];expected=C@matrix(b['matrixWorld'])@CI
        rest_error=max(rest_error,difference(bone.matrix_local,expected));inverse_error=max(inverse_error,difference(bone.matrix_local.inverted(),C@matrix(b['inverseBindMatrix'])@CI))
        stored=json.loads(rig.pose.bones[b['name']]['runtime_inverse_bind_json']);metadata_error=max(metadata_error,max(abs(x-y) for x,y in zip(stored,b['inverseBindMatrix'])))
        expected_parent=names[b['parent']] if b['parent']>=0 else None
        if (bone.parent.name if bone.parent else None)!=expected_parent:parents.append(b['name'])
        check('runtime-index/'+b['name'],rig.pose.bones[b['name']].get('runtime_index')==b['index'])
    check('canonical49-rest-and-inverse',max(rest_error,inverse_error)<1e-6 and metadata_error==0 and not parents,{'maxRestMatrixError':rest_error,'maxInverseRestError':inverse_error,'storedRuntimeInverseError':metadata_error,'parentMismatches':parents})
    check('canonical49-order-metadata',json.loads(rig.get('joint_order_json','[]'))==names)
    report['actualCanonicalRestMatrices']={n:{'rest':[list(row) for row in rig.data.bones[n].matrix_local],'inverse':[list(row) for row in rig.data.bones[n].matrix_local.inverted()]} for n in names}
    records=[]
    for original_mesh in source['meshes']:
        m=expected_mesh(original_mesh)
        ob=bpy.data.objects.get(m['name']);check('mesh-exists/'+m['name'],ob is not None and ob.type=='MESH')
        if ob is None:continue
        mesh=ob.data;positions=decode(m['attributes']['position']);count=m['attributes']['position']['count'];nm=C@matrix(m['matrixWorld'])
        changes={} if m.get('_declaredSockTopology') else {x['vertex']:Vector(x['deltaRuntimeMetres']) for x in (expected_geo or {}).get('neutralEdits',{}).get(m['name'],[])}
        basis=mesh.shape_keys.key_blocks[0].data if mesh.shape_keys else mesh.vertices
        position_error=0
        for i,v in enumerate(basis):
            expected=nm@Vector(positions[i*3:i*3+3]);expected+=C.to_3x3()@changes.get(i,Vector())
            position_error=max(position_error,(v.co-expected).length)
        check('neutral-source/'+m['name'],len(mesh.vertices)==count and position_error<1e-6,{'vertices':len(mesh.vertices),'expectedVertices':count,'maxNeutralPositionError':position_error})
        indices=decode(m['index']);expected_tri=[list(indices[i:i+3]) for i in range(0,len(indices),3)]
        if m['name']=='niko-body' and expected_geo:expected_tri+=expected_geo.get('visibleMaskEdit',{}).get('addedOriginalSourceTriangles',[])
        actual_tri=[list(poly.vertices) for poly in mesh.polygons]
        actual_counter=collections.Counter(oriented(x) for x in actual_tri if len(x)==3);expected_counter=collections.Counter(oriented(x) for x in expected_tri)
        check('index-mask/'+m['name'],all(len(x)==3 for x in actual_tri) and actual_counter==expected_counter,{'actualTriangles':len(actual_tri),'expectedTriangles':len(expected_tri),'missing':sum((expected_counter-actual_counter).values()),'unexpected':sum((actual_counter-expected_counter).values())})
        uv_error=0;missing_uv=[]
        for name,attribute in m['attributes'].items():
            if name not in ['uv','uv1','uv2']:continue
            if name not in mesh.uv_layers:missing_uv.append(name);continue
            data=decode(attribute);layer=mesh.uv_layers[name]
            for loop in mesh.loops:
                uv=layer.data[loop.index].uv;i=loop.vertex_index;uv_error=max(uv_error,abs(uv.x-data[i*2]),abs(uv.y-data[i*2+1]))
        check('source-uv/'+m['name'],not missing_uv and uv_error<2e-7,{'missing':missing_uv,'maxError':uv_error})
        native_attribute_checks(ob)
        check('native-geometric-normals-finite/'+m['name'],all(math.isfinite(v) for n in mesh.corner_normals for v in n.vector),{'cornerNormals':len(mesh.corner_normals),'scope':'Computed geometric normals; opaque custom_normal tangent-basis encoding intentionally not treated as a shader alias.'})
        if m.get('_declaredSockTopology'):declared_sock_topology_checks(ob)
        si=decode(m['attributes']['skinIndex']);sw=decode(m['attributes']['skinWeight']);override={x['vertex']:x['after'] for x in (expected_geo or {}).get('weightEdits',{}).get(m['name'],[])}
        weight_error=0;sum_error=0;max_influences=0;unknown=[];weight_examples=[]
        all_actual_weights=[]
        for i,v in enumerate(mesh.vertices):
            expected={}
            for k in range(4):
                w=sw[i*4+k]
                if w>0:n=names[si[i*4+k]];expected[n]=expected.get(n,0)+w
            expected=override.get(i,expected);actual={ob.vertex_groups[x.group].name:x.weight for x in v.groups if x.weight>0}
            unknown.extend(x for x in actual if x not in names);max_influences=max(max_influences,len(actual));sum_error=max(sum_error,abs(sum(actual.values())-1))
            if m['name'] in ['niko-body','niko-jersey','niko-socks']:all_actual_weights.append([[names.index(n),w] for n,w in actual.items()])
            error=max((abs(expected.get(n,0)-actual.get(n,0)) for n in set(expected)|set(actual)),default=0);weight_error=max(weight_error,error)
            if error>1e-7 and len(weight_examples)<8:weight_examples.append({'vertex':i,'expected':expected,'actual':actual,'sum':sum(actual.values()),'maxDifference':error})
        check('skin-weights/'+m['name'],weight_error<1e-7 and sum_error<1e-6 and max_influences<=4 and not unknown,{'maxSourceDifference':weight_error,'maxSumError':sum_error,'maxInfluences':max_influences,'unknownBones':list(set(unknown)),'mismatchExamples':weight_examples})
        if all_actual_weights:report.setdefault('actualChangedMeshWeights',{})[m['name']]={'canonicalJointOrder':names,'rowsBySourceVertexID':all_actual_weights}
        if m['name']=='niko-jersey' and expected_geo and expected_geo.get('jerseyWeightControls'):
            policy=expected_geo['jerseyWeightControls'];forbidden=policy.get('forbiddenBones',[]);leaks=[{'vertex':i,'bone':ob.vertex_groups[g.group].name,'weight':g.weight} for i,v in enumerate(mesh.vertices) for g in v.groups if g.weight>1e-7 and ob.vertex_groups[g.group].name in forbidden]
            if forbidden:check('garment-forbidden-influences',not leaks,{'policy':forbidden,'violations':leaks[:12]})
            if policy.get('collarRowsChestBound')==[0,10]:
                ids=sorted({r['vertex'] for r in m['userData']['authoredCollarSource']['records']});error=max(max(abs({ob.vertex_groups[g.group].name:g.weight for g in mesh.vertices[i].groups}.get(n,0)-(1 if n=='chest' else 0)) for n in names) for i in ids);check('all-collar-source-rows-chest-bound',error<1e-7,{'sourceVertices':len(ids),'maxWeightError':error})
        mods=[x for x in ob.modifiers if x.type=='ARMATURE'];check('linear-skin-ownership/'+m['name'],len(mods)==1 and mods[0].object==rig and not mods[0].use_deform_preserve_volume)
        # The eight accepted facial coordinate arrays and defaults are independent of new corrective channels.
        face_error=0;face_names=m['morphTargetDictionary'];keys=mesh.shape_keys.key_blocks if mesh.shape_keys else None
        for name,index in face_names.items():
            if not keys or name not in keys:face_error=1e6;continue
            key=keys[name];values=decode(m['morphAttributes']['position'][index]);linear=nm.to_3x3()
            for i,v in enumerate(key.data):
                expected=basis[i].co+linear@Vector(values[i*3:i*3+3]) if m['morphTargetsRelative'] else nm@Vector(values[i*3:i*3+3])
                face_error=max(face_error,(v.co-expected).length)
        if face_names:check('face8-source-arrays/'+m['name'],len(face_names)==8 and face_error<1e-6,{'maxCoordinateError':face_error,'names':list(face_names)})
        sampled=[k.name for k in keys or [] if k.name.startswith('BASELINE_SAMPLED') and (not k.mute or abs(k.value)>1e-8)]
        if expected_geo:check('legacy-samples-muted/'+m['name'],not sampled,{'activeOldSamples':sampled})
        records.append({'name':m['name'],'vertices':len(mesh.vertices),'triangles':len(mesh.polygons),'shapeKeys':len(keys) if keys else 0,'keyFamilies':{'acceptedFace':len(face_names),'mutedLegacySamples':sum(k.name.startswith('BASELINE_SAMPLED') and k.mute for k in keys or []),'authoredR11':sum(k.name.startswith('R11_') for k in keys or []),'nativeOnlyPreservedBoot':sum(k.name.startswith('PRESERVED_JOG_BOOT_') for k in keys or [])},'activeKeysAtSavedState':{k.name:k.value for k in keys or [] if k.name!='Basis' and not k.mute and abs(k.value)>1e-6}})
    report['sourceMeshes']=records
    if expected_geo:
        for record in expected_geo['correctives']:
            ob=bpy.data.objects[record['mesh']];keys=ob.data.shape_keys.key_blocks;key=keys.get(record['name']);max_error=0
            if key:
                deltas={x['vertex']:Vector(x['deltaNative']) for x in record['deltas']};basis=keys[0]
                for i,v in enumerate(key.data):max_error=max(max_error,(v.co-basis.data[i].co-deltas.get(i,Vector())).length)
            check('authored-corrective-source/'+record['name'],key is not None and max_error<1e-6,{'maxDeltaError':max_error,'muted':key.mute if key else None})

def update(rig):
    rig.update_tag(refresh={'OBJECT'});bpy.context.view_layer.update();bpy.context.view_layer.update()

def reset(rig):
    if rig.animation_data:rig.animation_data.action=None
    for pb in rig.pose.bones:pb.location=(0,0,0);pb.rotation_mode='QUATERNION';pb.rotation_quaternion=(1,0,0,0);pb.scale=(1,1,1)
    rig['JogContextEnabled']=0;update(rig)

def driver_values():
    return {r['name']:bpy.data.objects[r['mesh']].data.shape_keys.key_blocks[r['name']].value for r in (expected_geo or {}).get('correctives',[])}

def driver_checks(rig):
    if not expected_geo:return
    rows=[]
    reset(rig);values=driver_values();check('driver-zero-neutral',all(abs(x)<1e-6 for x in values.values()),values)
    for side,sign in [('L',1),('R',-1)]:
        for kind,angles in [('shoulder',[20,30,45,67.5,90]),('knee',[10,30,60,90,120])]:
            for degrees in angles:
                reset(rig);name=('upperArm' if kind=='shoulder' else 'lowerLeg')+side
                axis=(0,0,1) if kind=='shoulder' else (1,0,0);angle=math.radians(degrees)*(sign if kind=='shoulder' else 1)
                rig.pose.bones[name].rotation_quaternion=CQ@Quaternion(axis,angle)@CQ.conjugated();update(rig)
                actual=driver_values();expected={};max_error=0
                declared_drivers={r['key']:r for r in expected_geo['drivers']}
                for rec in expected_geo['correctives']:
                    val=0
                    driver=declared_drivers[rec['name']]
                    if driver['bone']==name:
                        peak=driver['peakRadians'];other=driver['adjacentPeakRadians'];a=abs(angle);onset=driver['onsetRadians']
                        val=max(0,min(1,(a-onset)/(peak-onset)))*max(0,min(1,(other-a)/(other-peak))) if peak<other else max(0,min(1,(a-other)/(peak-other)))
                    expected[rec['name']]=val;max_error=max(max_error,abs(actual[rec['name']]-val))
                check('driver-intermediate/'+kind+'/'+side+'/'+str(degrees),max_error<3e-5,{'maxError':max_error,'values':actual});rows.append({'kind':kind,'side':side,'degrees':degrees,'values':actual})
        for forward in [45,89,90,120]:
            reset(rig);rig.pose.bones['upperArm'+side].rotation_quaternion=CQ@Quaternion((1,0,0),math.radians(forward))@CQ.conjugated();update(rig)
            vals=driver_values();rows.append({'kind':'pure-forward-stress','side':side,'degrees':forward,'values':vals})
            # True lateral elevation remains zero even when forward motion passes horizontal.
            check('driver-forward-isolation/'+side+'/'+str(forward),all(abs(v)<1e-5 for k,v in vals.items() if 'Shoulder' in k),vals)
    reset(rig);values=driver_values();check('driver-return-zero-after-extremes',all(abs(x)<1e-6 for x in values.values()),values);face_weights('after-driver-extremes')
    report['driverPoseSamples']=rows

def cycle_checks(rig):
    if not motion:return
    action=bpy.data.actions.get('NIKO_JOG_SUPPORTED_V1');check('native-supported-action',action is not None)
    if not action:return
    rig.animation_data_create();rig.animation_data.action=action;cadence=motion['cadence'];fps=bpy.context.scene.render.fps/bpy.context.scene.render.fps_base;period_frames=fps/cadence
    rows=[];max_values={k:0 for k in driver_values()};face_error=0
    check('jog-phase-property-float-before-manual-tests',isinstance(rig.get('JogPhase'),float),{'type':type(rig.get('JogPhase')).__name__,'value':rig.get('JogPhase')})
    for phase in [0,.0625,.125,.12708333333333333,.25,.375,.3770833333333333,.5,.625,.6270833333333333,.75,.875,.8770833333333333,1]:
        f=1+phase*period_frames;bpy.context.scene.frame_set(math.floor(f),subframe=f%1);update(rig)
        vals=driver_values()
        for k,v in vals.items():max_values[k]=max(max_values[k],v)
        face_weights('cycle-'+str(phase));actual_phase=rig.get('JogPhase');phase_error=min(abs(actual_phase-phase),abs(actual_phase-phase-1),abs(actual_phase-phase+1));check('jog-phase-continuity/'+str(phase),phase_error<1e-5 and rig.get('JogContextEnabled')==1,{'phase':phase,'actualJogPhase':actual_phase,'moduloPhaseError':phase_error,'context':rig.get('JogContextEnabled')})
        boot_keys=bpy.data.objects['niko-boots'].data.shape_keys.key_blocks;prefix='PRESERVED_JOG_BOOT_'
        if prefix+'000' in boot_keys:
            use_phase=0 if abs(actual_phase)<1e-6 and abs(phase-1)<1e-6 else phase
            expected=[max(0,1-abs(use_phase-i/240)*240) for i in range(241)];actual=[boot_keys[prefix+str(i).zfill(3)].value for i in range(241)];weight_error=max(abs(a-b) for a,b in zip(actual,expected))
            check('animated-boot-neighbor-weights/'+str(phase),weight_error<3e-5 and abs(sum(actual)-1)<1e-5,{'maxWeightError':weight_error,'weightSum':sum(actual),'activeIndices':[i for i,v in enumerate(actual) if v>1e-5]})
        rows.append({'phase':phase,'frame':f,'values':vals,'JogPhase':actual_phase,'JogContextEnabled':rig.get('JogContextEnabled')})
    check('cycle-drivers-evaluate',all(math.isfinite(v) and -1e-6<=v<=1.00001 for row in rows for v in row['values'].values()),{'maximumValues':max_values})
    # Shoulder jog contribution may correctly remain zero: pureforward flow is not lateral abduction.
    if expected_geo:check('cycle-knee-deformation-active',all(any(v>1e-4 for k,v in max_values.items() if 'Patella' in k and '_'+side+'_' in k) for side in ['L','R']),max_values)
    report['cycleSamples']=rows;reset(rig);check('driver-return-zero-after-cycle',all(abs(v)<1e-6 for v in driver_values().values()),driver_values())

def motion_contract_checks(rig):
    if not motion:return
    allowed={'pelvisLocalPositionMetres','pelvisQuaternion','upperBodyAndHands','kneePoleRootSpace'}
    check('motion-channel-authority-whitelist',set(motion.get('runtimeChannels',[]))==allowed,{'channels':motion.get('runtimeChannels')})
    contacts=ROOT/'motion/baseline-contact-samples.json'
    rest_contract=json.loads((ROOT/'verified-source/reference-clip-contact-manifest.json').read_bytes())['rig']
    expected_rest_sha=hashlib.sha256(json.dumps(rest_contract,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    check('motion-source-contract-hashes',motion.get('baselineContactSamplesSha256')==hashlib.sha256(contacts.read_bytes()).hexdigest() and motion.get('canonicalRestSha256')==expected_rest_sha)
    rows=motion['samples'];upper=set(rows[0]['upperBodyAndHands']);expected_names=set(x['name'] for x in source['rig']['bones'])-{'hips','upperLegL','lowerLegL','footL','toeL','upperLegR','lowerLegR','footR','toeR'}
    qerror=0;pole_error=0
    for s in rows:
        for q in [s['pelvisQuaternion'],*s['upperBodyAndHands'].values()]:qerror=max(qerror,abs(sum(x*x for x in q)-1))
        for pole in s['kneePoleRootSpace'].values():pole_error=max(pole_error,abs(sum(x*x for x in pole)-1))
    check('motion-unit-control-contract',qerror<1e-12 and pole_error<1e-12 and upper==expected_names,{'maxQuaternionSquaredNormError':qerror,'maxPoleSquaredNormError':pole_error,'upperAndHandChannels':len(upper)})
    action=bpy.data.actions.get('NIKO_JOG_SUPPORTED_V1')
    if not action:return
    rig.animation_data_create();rig.animation_data.action=action
    def sample_at(phase):
        right=next((i for i,s in enumerate(rows) if s['phase']>=phase),len(rows)-1);left=max(0,right-1);a=rows[left];b=rows[right];dt=b['phase']-a['phase'];u=(phase-a['phase'])/dt if dt else 0
        h00=2*u**3-3*u*u+1;h10=u**3-2*u*u+u;h01=-2*u**3+3*u*u;h11=u**3-u*u
        def values(field,name=None):
            av=a[field][name] if name else a[field];bv=b[field][name] if name else b[field];at=a['tangentsPerPhase'][field][name] if name else a['tangentsPerPhase'][field];bt=b['tangentsPerPhase'][field][name] if name else b['tangentsPerPhase'][field]
            return [h00*x+h10*dt*dx+h01*y+h11*dt*dy for x,dx,y,dy in zip(av,at,bv,bt)]
        return values
    max_position=0;max_quaternion=0;probes=[];fps=bpy.context.scene.render.fps/bpy.context.scene.render.fps_base
    for phase in [0,.0015,.0637,.127,.249,.3337,.5007,.689,.8123,.9371,.9991,1]:
        f=1+phase*fps/motion['cadence'];bpy.context.scene.frame_set(math.floor(f),subframe=f%1);update(rig);sample=sample_at(phase)
        hips=rig.pose.bones['hips'];actual=CI.to_3x3()@hips.location+Vector(source['rig']['bones'][0]['localPosition']);expected=Vector(sample('pelvisLocalPositionMetres'));pe=(actual-expected).length;max_position=max(max_position,pe)
        qe=0
        for name in ['hips',*sorted(upper)]:
            q=sample('pelvisQuaternion') if name=='hips' else sample('upperBodyAndHands',name);expected=Quaternion((q[3],q[0],q[1],q[2])).normalized();actual=(CQ.conjugated()@rig.pose.bones[name].rotation_quaternion.normalized()@CQ).normalized();actual.make_compatible(expected);qe=max(qe,max(abs(actual[i]-expected[i]) for i in range(4)))
        max_quaternion=max(max_quaternion,qe);probes.append({'phase':phase,'pelvisPositionError':pe,'maxQuaternionComponentError':qe})
    check('native-versus-exported-hermite',max_position<2e-5 and max_quaternion<2e-5,{'maxPositionErrorMetres':max_position,'maxQuaternionComponentError':max_quaternion,'samples':probes})
    reset(rig)

def evaluated_positions(ob):
    evaluated=ob.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=evaluated.to_mesh();values=[v.co.copy() for v in mesh.vertices];world=evaluated.matrix_world.copy();evaluated.to_mesh_clear();return values,world

def useful_geometry_checks(rig):
    if not(expected_geo and motion):return
    action=bpy.data.actions.get('NIKO_JOG_SUPPORTED_V1')
    if not action:return
    rig.animation_data_create();rig.animation_data.action=action;fps=bpy.context.scene.render.fps/bpy.context.scene.render.fps_base
    rows=[]
    for phase in [0,.125,.25,.5,.75]:
        f=1+phase*fps/motion['cadence'];bpy.context.scene.frame_set(math.floor(f),subframe=f%1);update(rig)
        for mesh_name in sorted({r['mesh'] for r in expected_geo['correctives']}):
            ob=bpy.data.objects[mesh_name];keys=ob.data.shape_keys.key_blocks;newkeys=[keys[r['name']] for r in expected_geo['correctives'] if r['mesh']==mesh_name];saved=[k.mute for k in newkeys]
            for k in newkeys:k.mute=False
            ob.data.shape_keys.update_tag();ob.update_tag(refresh={'DATA'});update(rig);on,world=evaluated_positions(ob);values={k.name:k.value for k in newkeys};active=sum(values.values())
            for k in newkeys:k.mute=True
            ob.data.shape_keys.update_tag();ob.update_tag(refresh={'DATA'});update(rig);off,_=evaluated_positions(ob)
            max_actual=0;max_error=0;basis=keys[0];to_rig=(rig.matrix_world.inverted()@ob.matrix_world).to_3x3();to_world=rig.matrix_world.to_3x3();skin={name:(pb.matrix@pb.bone.matrix_local.inverted()).to_3x3() for name,pb in rig.pose.bones.items()}
            for i,v in enumerate(ob.data.vertices):
                delta=sum(((k.data[i].co-basis.data[i].co)*values[k.name] for k in newkeys),Vector());delta=to_rig@delta;predicted=Vector();weight_sum=sum(g.weight for g in v.groups)
                for group in v.groups:
                    name=ob.vertex_groups[group.group].name
                    if name in skin:predicted+=(skin[name]@delta)*group.weight
                if weight_sum>1e-12:predicted/=weight_sum
                predicted=to_world@predicted;actual=world.to_3x3()@(on[i]-off[i]);max_actual=max(max_actual,actual.length);max_error=max(max_error,(actual-predicted).length)
            for k,mute in zip(newkeys,saved):k.mute=mute
            ob.data.shape_keys.update_tag();ob.update_tag(refresh={'DATA'});update(rig)
            check('useful-evaluated-corrective/'+mesh_name+'/'+str(phase),max_error<2e-5 and (active<1e-4 or max_actual>1e-6),{'phase':phase,'driverValues':values,'maxActualWorldPositionChangeMetres':max_actual,'maxDifferenceFromIndependentLinearSkinPredictionMetres':max_error})
            rows.append({'phase':phase,'mesh':mesh_name,'values':values,'actualWorldDelta':max_actual,'linearPredictionError':max_error})
    report['evaluatedCorrectiveGeometry']=rows;reset(rig)

def boot_context_checks(rig):
    path=ROOT/'runtime-assessment/boot-reference/jog-context-boot-flex.json'
    if not(motion and path.exists()):return
    boot_data=json.loads(path.read_bytes());ob=bpy.data.objects['niko-boots'];keys=ob.data.shape_keys.key_blocks;basis=co_array(keys[0]);prefix='PRESERVED_JOG_BOOT_';names=[prefix+str(i).zfill(3) for i in range(len(boot_data['samples']))];check('preserved-boot241-source-hash',ob.data.shape_keys.get('sourceSHA256')==hashlib.sha256(path.read_bytes()).hexdigest())
    check('preserved-boot241-key-identities',set(k.name for k in keys if k.name.startswith(prefix))==set(names))
    max_error=0
    for name,sample in zip(names,boot_data['samples']):
        actual=co_array(keys[name]);delta=decode(sample['positionDelta'])
        for i in range(len(basis)//3):
            max_error=max(max_error,abs(actual[i*3]-basis[i*3]-delta[i*3]),abs(actual[i*3+1]-basis[i*3+1]+delta[i*3+2]),abs(actual[i*3+2]-basis[i*3+2]-delta[i*3+1]))
    check('preserved-boot241-key-coordinates',max_error<1e-6,{'maxNativeDeltaError':max_error,'normalsScope':'Reference normal arrays remain source data; native shading recalculates independently.'})
    reset(rig);rows=[]
    phases=[0,1/240,.0001,.125,.2337,.333,103/240,.5,.75,.7899,239/240,1]
    for context in [0,1]:
        for phase in phases:
            rig['JogContextEnabled']=context;rig['JogPhase']=float(phase);update(rig);actual=[keys[n].value for n in names];expected=[]
            samples=boot_data['samples']
            for i,s in enumerate(samples):
                if i==0:v=max(0,min(1,(samples[1]['phase']-phase)/samples[1]['phase']))
                elif i==len(samples)-1:v=max(0,min(1,(phase-samples[-2]['phase'])/(1-samples[-2]['phase'])))
                else:v=max(0,min(1,(phase-samples[i-1]['phase'])/(s['phase']-samples[i-1]['phase']),(samples[i+1]['phase']-phase)/(samples[i+1]['phase']-s['phase'])))
                expected.append(context*v)
            error=max(abs(a-b) for a,b in zip(actual,expected));total=sum(actual)
            check('preserved-boot-phase-context/'+str(context)+'/'+str(phase),error<1e-5 and abs(total-context)<1e-5,{'maxWeightError':error,'weightSum':total,'activeKeys':sum(x>1e-6 for x in actual)});rows.append({'context':context,'phase':phase,'maxWeightError':error,'weightSum':total})
    report['bootContextSamples']=rows
    if motion:
        action=bpy.data.actions.get('NIKO_JOG_SUPPORTED_V1');rig.animation_data_create();rig.animation_data.action=action;fps=bpy.context.scene.render.fps/bpy.context.scene.render.fps_base;floor=[]
        reference=json.loads((ROOT/'motion/baseline-contact-samples.json').read_bytes());source_mesh=next(m for m in source['meshes'] if m['name']=='niko-boots');skin_indices=decode(source_mesh['attributes']['skinIndex']);skin_weights=decode(source_mesh['attributes']['skinWeight']);neutral=decode(boot_data['neutral']['position']);inverse={b['index']:matrix(b['inverseBindMatrix']) for b in source['rig']['bones']};foot_index={b['name']:b['index'] for b in source['rig']['bones'] if b['name'] in ['footL','footR']};max_world_error=0;max_foot_error=0
        for phase in [0,.0625,.125,.25,.375,.5,.625,.75,.875,1]:
            f=1+phase*fps/motion['cadence'];bpy.context.scene.frame_set(math.floor(f),subframe=f%1);update(rig);coords,world=evaluated_positions(ob);minimum={'L':1e9,'R':1e9};expected_min={'L':1e9,'R':1e9};si=round(phase*240);frozen=reference['samples'][si];delta=decode(boot_data['samples'][si]['positionDelta']);matrices={};foot_error=0
            for side in ['L','R']:
                target=frozen['feet'][side];v=target['quaternion'];m=Quaternion((v[3],v[0],v[1],v[2])).to_matrix().to_4x4();m.translation=Vector(target['position']);matrices[foot_index['foot'+side]]=m;actual=rig.matrix_world@rig.pose.bones['foot'+side].matrix;foot_error=max(foot_error,difference(actual,C@m@CI))
            max_foot_error=max(max_foot_error,foot_error);world_error=0
            for i,v in enumerate(coords):
                side='L' if basis[i*3]>0 else 'R';actual=world@v;minimum[side]=min(minimum[side],actual.z);point=Vector([neutral[i*3+c]+delta[i*3+c] for c in range(3)]);expected=Vector()
                for k in range(4):
                    index=skin_indices[i*4+k];weight=skin_weights[i*4+k]
                    if weight:
                        if index not in matrices:raise RuntimeError('Unexpected nonfoot bootweight in CPUreference')
                        expected+=(matrices[index]@inverse[index]@point)*weight
                expected=C@expected;expected_min[side]=min(expected_min[side],expected.z);world_error=max(world_error,(actual-expected).length)
            max_world_error=max(max_world_error,world_error);floor.append({'phase':phase,'nativeMinimumZ':minimum,'cpuReferenceMinimumZ':expected_min,'maxNativeVsCpuVertexError':world_error,'maxFootMatrixError':foot_error})
        check('native-jog-foot-matrices-vs-frozen-reference',max_foot_error<2e-6,{'maxMatrixError':max_foot_error})
        check('native-jog-visible-boots-vs-unchanged-cpu-reference',max_world_error<2e-5,{'maxWorldVertexErrorMetres':max_world_error})
        report['nativeVisibleBootFloorBounds']=floor
    reset(rig)

def protected_curve_hash(action):
    rows=[]
    for f in action.fcurves:
        if f.data_path=='["JogContextEnabled"]':continue
        rows.append({'path':f.data_path,'index':f.array_index,'extrapolation':f.extrapolation,'keys':[{'co':list(k.co),'left':list(k.handle_left),'right':list(k.handle_right),'interpolation':k.interpolation,'leftType':k.handle_left_type,'rightType':k.handle_right_type} for k in f.keyframe_points],'modifiers':[{'type':m.type,'modeBefore':getattr(m,'mode_before',None),'modeAfter':getattr(m,'mode_after',None)} for m in f.modifiers]})
    return hashlib.sha256(json.dumps(sorted(rows,key=lambda x:(x['path'],x['index'])),sort_keys=True,separators=(',',':')).encode()).hexdigest()

def legacy_context_guards(rig):
    sc=bpy.context.scene
    if 'PlayQubeGuardedJogContextActions' not in sc:return
    legacy=json.loads(sc['PlayQubeGuardedJogContextActions']);supported=json.loads(sc['PlayQubeSupportedJogContextActions']);metadata={r['action']:r for r in json.loads(sc['PlayQubeJogContextGuardReport'])}
    check('explicit-native-context-action-sets',len(legacy)==13 and len(supported)==2 and not set(legacy)&set(supported) and all(n.startswith('REFERENCE_runtime_') for n in legacy),{'legacy':legacy,'supported':supported})
    baseline_path=args.motion.parent/'Player_Jog.blend' if args.motion else None;baseline_hashes={}
    if baseline_path and baseline_path.exists():
        with bpy.data.libraries.load(str(baseline_path),link=False) as (before,loaded):loaded.actions=legacy+supported
        for name,action in zip(legacy+supported,loaded.actions):
            if action:baseline_hashes[name]=protected_curve_hash(action)
        for action in loaded.actions:
            if action:bpy.data.actions.remove(action)
        report['contextGuardBaselineCore']={'file':str(baseline_path),'sha256':hashlib.sha256(baseline_path.read_bytes()).hexdigest()}
    rows=[];boot=bpy.data.objects['niko-boots'];keys=boot.data.shape_keys.key_blocks;boot_names=[k.name for k in keys if k.name.startswith('PRESERVED_JOG_BOOT_')]
    for name,expected in [(n,0) for n in legacy]+[(n,1) for n in supported]:
        action=bpy.data.actions.get(name);check('guard-action-present/'+name,action is not None)
        if not action:continue
        actual_hash=protected_curve_hash(action);record=metadata.get(name,{});unchanged=record.get('protectedJointRootPhaseCurvesBefore')==record.get('protectedJointRootPhaseCurvesAfter')==actual_hash
        if baseline_hashes:unchanged=unchanged and baseline_hashes.get(name)==actual_hash
        check('guard-protected-curves-unchanged/'+name,unchanged,{'actualHash':actual_hash,'baselineCoreHash':baseline_hashes.get(name)})
        rig.animation_data_create();rig.animation_data.action=action;first,last=map(float,action.frame_range)
        for fraction in [0,.5,1]:
            frame=first+(last-first)*fraction;sc.frame_set(math.floor(frame),subframe=frame%1);update(rig);value=rig.get('JogContextEnabled');boot_max=max((abs(keys[n].value) for n in boot_names),default=0)
            check('guard-actual-playback/'+name+'/'+str(fraction),abs(value-expected)<1e-8 and (expected==1 or boot_max<1e-7),{'frame':frame,'actualContext':value,'expectedContext':expected,'maximumBootReferenceWeight':boot_max});rows.append({'action':name,'fraction':fraction,'context':value,'maximumBootWeight':boot_max})
    report['nativeContextGuardPlayback']=rows;reset(rig)

def anatomical_calf_coverage(rig):
    """Specific exposed-calf regression; restricted shin surface, not whole-body collision acceptance."""
    sock=bpy.data.objects['niko-socks'];body=bpy.data.objects['niko-body'];basis=sock.data.shape_keys.key_blocks[0].data if sock.data.shape_keys else sock.data.vertices
    neutral=[CI@v.co for v in basis];wrap=bpy.data.objects.get('REFERENCE_JOG_ROOT_TRAJECTORY_2p4mps')
    saved_action=wrap.animation_data.action if wrap and wrap.animation_data else None
    if wrap:
        if wrap.animation_data:wrap.animation_data.action=None
        wrap.matrix_world=Matrix.Identity(4)
    rows=[];rest={b['name']:b for b in source['rig']['bones']}
    for degrees in [0,60,90,120]:
        reset(rig);rig.matrix_basis=Matrix.Identity(4)
        pose=source['poseVariants']['bindNeutral'] if degrees==0 else next(s['pose'] for s in source['correctiveSamples'] if s['definition']['kind']=='knee' and abs(s['definition']['angle']-math.radians(degrees))<1e-6)
        for b in pose['bones']:
            pb=rig.pose.bones[b['name']];pb.location=C.to_3x3()@Vector([b['localPosition'][i]-rest[b['name']]['localPosition'][i] for i in range(3)]);q=b['localQuaternion'];pb.rotation_mode='QUATERNION';pb.rotation_quaternion=CQ@Quaternion((q[3],q[0],q[1],q[2]))@CQ.conjugated();pb.scale=b['localScale']
        update(rig);body_points,body_world=evaluated_positions(body);ev=sock.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=ev.to_mesh();mesh.calc_loop_triangles();sock_points=[v.co.copy() for v in mesh.vertices];sock_world=ev.matrix_world.copy();all_triangles=[(t.polygon_index,list(t.vertices)) for t in mesh.loop_triangles];ev.to_mesh_clear()
        for side,body_id,sign in [('L',8725,1),('R',3638,-1)]:
            selected=[(pi,ids) for pi,ids in all_triangles if all(sign*neutral[i].x>0 and .37<=neutral[i].y<=.455 for i in ids)]
            check('calf-anatomical-surface-present/'+side+'/'+str(degrees),bool(selected),{'triangles':len(selected),'neutralYBand':[.37,.455],'sameLeg':side})
            if not selected:continue
            bvh=BVHTree.FromPolygons(sock_points,[x[1] for x in selected],all_triangles=True);point=body_world@body_points[body_id];near,normal,face,distance=bvh.find_nearest(sock_world.inverted()@point);near_world=sock_world@near;normal_world=(sock_world.to_3x3().inverted().transposed()@normal).normalized()
            shin=rig.matrix_world@rig.pose.bones['lowerLeg'+side].matrix;axis=(shin.to_3x3()@Vector((0,0,-1))).normalized();radial=point-shin.translation;radial-=axis*radial.dot(axis);radial.normalize();alignment=normal_world.dot(radial)
            if alignment<0:normal_world.negate();alignment=-alignment
            signed=(point-near_world).dot(normal_world);record={'degrees':degrees,'side':side,'bodySourceVertex':body_id,'bodyPointWorldNative':list(point),'sockNearestWorldNative':list(near_world),'sockPolygon':selected[face][0],'sockSourceVertexIDs':selected[face][1],'outwardNormalWorld':list(normal_world),'normalRadialAlignment':alignment,'unsignedGapMetres':(point-near_world).length,'signedOutwardGapMetres':signed,'anatomicalRegion':'same-side shin, neutral y.37–.455; excludes opposing thigh/fold'}
            check('calf-surface-encloses-source-point/'+side+'/'+str(degrees),alignment>.35 and signed<=1e-5,record);rows.append(record)
    report['anatomicalCalfCoverage']=rows
    if wrap and wrap.animation_data:wrap.animation_data.action=saved_action
    reset(rig)

def jersey_hem_arm_isolation(rig):
    ob=bpy.data.objects['niko-jersey'];basis=ob.data.shape_keys.key_blocks[0].data if ob.data.shape_keys else ob.data.vertices;ids=[i for i,v in enumerate(basis) if (CI@v.co).y<1.10];wrap=bpy.data.objects.get('REFERENCE_JOG_ROOT_TRAJECTORY_2p4mps');saved_action=wrap.animation_data.action if wrap and wrap.animation_data else None
    if wrap:
        if wrap.animation_data:wrap.animation_data.action=None
        wrap.matrix_world=Matrix.Identity(4)
    reset(rig);rig.matrix_basis=Matrix.Identity(4);update(rig);neutral,world=evaluated_positions(ob);rows=[]
    for side,sign in [('L',1),('R',-1)]:
        reset(rig);rig.matrix_basis=Matrix.Identity(4);rig.pose.bones['upperArm'+side].rotation_quaternion=CQ@Quaternion((0,0,1),sign*math.pi/2)@CQ.conjugated();update(rig);posed,world=evaluated_positions(ob);error=max(((world.to_3x3()@(posed[i]-neutral[i])).length for i in ids),default=0);record={'side':side,'pureUpperArmDegrees':90,'allOther49Locals':'rest','previewRoot':'identity','sourceNeutralYBelow':1.10,'vertices':len(ids),'maxWorldDisplacementMetres':error};check('jersey-hem-independent-of-free-arm/'+side,error<=2e-6,record);rows.append(record)
    report['jerseyHemArmIsolation']=rows
    if wrap and wrap.animation_data:wrap.animation_data.action=saved_action
    reset(rig)

try:
    capture_native_baseline_attributes();rig=open_input();structural(rig);face_weights('reopened-saved-state');dependencies('first-reopen');driver_checks(rig);cycle_checks(rig);motion_contract_checks(rig);useful_geometry_checks(rig);boot_context_checks(rig);legacy_context_guards(rig);anatomical_calf_coverage(rig);jersey_hem_arm_isolation(rig)
    first_face=face_weights('after-cycle-reset')
    rig=open_input();second_face=face_weights('second-reopen-saved-state');dependencies('second-reopen')
    check('face-defaults-stable-after-second-reopen',first_face==second_face)
    check('input-blend-byte-unchanged',hashlib.sha256(args.blend.read_bytes()).hexdigest()==report['inputSHA256'])
    report['status']='PASS' if not report['failures'] else 'FAIL'
except Exception as exc:
    report['status']='ERROR';report['exception']=repr(exc);report['traceback']=traceback.format_exc()
args.out.parent.mkdir(parents=True,exist_ok=True);args.out.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'status':report['status'],'input':str(args.blend),'report':str(args.out),'checks':len(report['checks']),'failures':len(report['failures']),'exception':report.get('exception')}))
if report['status']!='PASS':raise RuntimeError('Native independent validator '+report['status'])
