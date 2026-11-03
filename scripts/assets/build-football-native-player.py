#!/usr/bin/env python3
"""Export the pinned V5 source-ID patch, never an evaluated preview scene.
Standard library only. Baseline is retained in the immutable native evidence ZIP.
No Blender helpers, actions, cameras, hidden rigs or boot sample keys are read.
"""
import argparse, array, base64, hashlib, json, math, struct
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT/'scripts/assets/native-player/deformation-authoring-source.json'
SOURCE_SHA = 'a789a7a9635f8bc20829e59557b2f1c37d3de8788be2facd3687202bc5e4bc32'
TYPES = {'Float32Array': 'f', 'Uint16Array': 'H', 'Uint32Array': 'I'}

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def decode(a):
    v = array.array(TYPES[a['typedArray']]); v.frombytes(base64.b64decode(a['dataBase64']))
    assert len(v) == a['count'] * a['itemSize']
    return list(v)

def normal_field(p, ix, old):
    # Weld only source-equivalent smooth corners. Do not smooth authored creases.
    keys = [tuple(round(x, 7) for x in p[i:i+3]) + tuple(round(x, 4) for x in old[i:i+3]) for i in range(0,len(p),3)]
    sums = {k:[0.,0.,0.] for k in keys}
    for j in range(0,len(ix),3):
        a,b,c = ix[j:j+3];u=[p[b*3+k]-p[a*3+k] for k in range(3)];v=[p[c*3+k]-p[a*3+k] for k in range(3)]
        n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
        for q in (a,b,c):
            for k in range(3): sums[keys[q]][k]+=n[k]
    result=[]
    for i,key in enumerate(keys):
        n=sums[key];length=math.sqrt(sum(x*x for x in n));result.extend([x/length for x in n] if length>1e-15 else old[i*3:i*3+3])
    return result

def affected_neighbours(ix, changed):
    result=set(changed)
    for j in range(0,len(ix),3):
        ids=ix[j:j+3]
        if any(i in changed for i in ids):result.update(ids)
    return result

def export(baseline, out):
    assert sha(SOURCE)==SOURCE_SHA, 'Authoring JSON changed'
    assert sha(baseline)=='6e18412d06a94b8bfda4133f51bde9ea7e53bea3f452ac395e3d1f25fb86a558', 'Baseline identity changed'
    d=json.loads(baseline.read_text());s=json.loads(SOURCE.read_text())
    assert d['rig']['boneCount']==49 and len(d['meshes'])==8
    bones=d['rig']['bones'];names=[b['name'] for b in bones]
    assert s['sockTopology']['canonicalVertexGroupOrder']==names
    meshes={m['name']:m for m in d['meshes']};assert set(meshes)=={'niko-'+n for n in ['head','hair','brows','body','jersey','shorts','socks','boots']}
    buffer=bytearray();views=[];accessors=[]
    def acc(values,size,kind='f',target=34962):
        values=array.array(kind, values); offset=len(buffer);buffer.extend(values.tobytes());buffer.extend(b'\0'*((-len(buffer))%4));views.append({'buffer':0,'byteOffset':offset,'byteLength':len(values)*values.itemsize, **({'target':target} if target else {})})
        a={'bufferView':len(views)-1,'componentType':{'f':5126,'H':5123,'I':5125}[kind],'count':len(values)//size,'type':{1:'SCALAR',2:'VEC2',3:'VEC3',4:'VEC4',16:'MAT4'}[size]}
        if size==3:a.update(min=[min(values[k::3]) for k in range(3)],max=[max(values[k::3]) for k in range(3)])
        accessors.append(a);return len(accessors)-1
    nodes=[{'name':b['name'],'translation':b['localPosition']} for b in bones]
    for b in bones:
        assert b['localQuaternion']==[0,0,0,1] and b['localScale']==[1,1,1]
        if b['parent']>=0:nodes[b['parent']].setdefault('children',[]).append(b['index'])
    ibm=acc([v for b in bones for v in b['inverseBindMatrix']],16,target=None)
    glmeshes=[];reports={};drivers=[]
    semantic={'position':'POSITION','normal':'NORMAL','uv':'TEXCOORD_0','uv1':'TEXCOORD_1','color':'COLOR_0','skinIndex':'JOINTS_0','skinWeight':'WEIGHTS_0'}
    for name,m in meshes.items():
        a={k:decode(v) for k,v in m['attributes'].items()};sizes={k:v['itemSize'] for k,v in m['attributes'].items()};ix=decode(m['index']);count=len(a['position'])//3
        assert count=={'niko-head':5479,'niko-hair':3177,'niko-brows':126,'niko-body':10212,'niko-jersey':1794,'niko-shorts':1695,'niko-socks':660,'niko-boots':2390}[name]
        oldnorm=a['normal'][:];morphs={k:[decode(v) for v in vals] for k,vals in m['morphAttributes'].items()};morphnames=list(m['morphTargetDictionary'])
        assert not any(k.startswith('BASELINE_') for k in morphnames)
        changed=set()
        for row in s['neutralEdits'].get(name,[]):
            i=row['vertex'];assert 0<=i<count and i not in changed;changed.add(i)
            for k in range(3):a['position'][i*3+k]+=row['deltaRuntimeMetres'][k]
        # V5 front ease is already merged in neutralEdits; applying it again is wrong.
        if name=='niko-body':
            assert sha(ROOT/'apps/web/public/models/football/continuous-body.glb')==s['visibleMaskEdit']['sourceRawBodySHA256']
            seen={tuple(sorted(ix[i:i+3])) for i in range(0,len(ix),3)}
            for tri in s['visibleMaskEdit']['addedOriginalSourceTriangles']:
                assert tuple(sorted(tri)) not in seen;ix.extend(tri)
            assert len(s['visibleMaskEdit']['addedOriginalSourceTriangles'])==102
        if name=='niko-socks':
            top=s['sockTopology'];count=top['newVertexCount'];assert count==726 and len(top['originalVertexMap'])==660 and len(top['newVertices'])==66
            a={'position':[v for p in top['neutralPositionsRuntimeMetres'] for v in p], 'uv':[v for p in top['uvPerVertex'] for v in p], 'skinIndex':[0]*(count*4),'skinWeight':[0.]*(count*4)};sizes={'position':3,'uv':2,'skinIndex':4,'skinWeight':4};ix=top['indices'];oldnorm=[0.,1.,0.]*count
            # Retain both mapped source point attributes, not preview shader aliases.
            for attr in top['pointAttributes']:
                key={'RuntimePreviewColor':'sourcePreviewColor','runtime_normal':'sourceReferenceNormal'}.get(attr['name'],attr['name'])
                rows=attr['values'];a[key]=[v for row in rows for v in (row if isinstance(row,list) else [row])];sizes[key]=len(a[key])//count
        for row in s['weightEdits'].get(name,[]):
            i=row['vertex'];assert 0<=i<count
            entries=list(row['nativeReadback'].items());assert len(entries)<=4 and abs(sum(w for _,w in entries)-1)<1e-6
            a['skinIndex'][i*4:i*4+4]=[names.index(b) for b,_ in entries]+[0]*(4-len(entries));a['skinWeight'][i*4:i*4+4]=[w for _,w in entries]+[0.]*(4-len(entries))
        if changed or name=='niko-socks':
            computed=normal_field(a['position'],ix,oldnorm);selected=affected_neighbours(ix,changed) if changed else set(range(count));a['normal']=oldnorm[:];sizes['normal']=3
            for i in selected:a['normal'][i*3:i*3+3]=computed[i*3:i*3+3]
        for correction in [c for c in s['correctives'] if c['mesh']==name]:
            delta=[0.]*(count*3);moved=set()
            for row in correction['deltas']:
                i=row['vertex'];assert 0<=i<count and i not in moved;moved.add(i)
                x,y,z=row['deltaNative'];delta[i*3:i*3+3]=[x,z,-y] # inverse C(x,y,z)=(x,-z,y)
            morphnames.append(correction['name']);morphs.setdefault('position',[]).append(delta)
            posed=[v+delta[i] for i,v in enumerate(a['position'])];pn=normal_field(posed,ix,a['normal']);nd=[0.]*(count*3)
            for i in affected_neighbours(ix,moved):
                nd[i*3:i*3+3]=[pn[i*3+k]-a['normal'][i*3+k] for k in range(3)]
            morphs.setdefault('normal',[]).append(nd)
            dr=next(v for v in s['drivers'] if v['key']==correction['name']);drivers.append({'mesh':name,'key':correction['name'],'kind':'shoulder' if 'Shoulder' in correction['name'] else 'knee','side':correction['side'],**{k:dr[k] for k in ['bone','onsetRadians','peakRadians','adjacentPeakRadians']}})
        a['runtimeSourceId']=list(range(count));sizes['runtimeSourceId']=1
        attributes={semantic.get(k,'_'+k.upper()):acc(v,sizes[k],kind='H' if k in ('skinIndex','runtimeSourceId') else 'f') for k,v in a.items()}
        targets=[{semantic[k]:acc(vals[i],3) for k,vals in morphs.items()} for i in range(len(morphnames))]
        primitive={'attributes':attributes,'indices':acc(ix,1,'H',34963),'mode':4}
        if targets:primitive['targets']=targets
        glmeshes.append({'name':name,'primitives':[primitive],**({'weights':[0]*len(morphnames),'extras':{'targetNames':morphnames}} if targets else {})})
        nodes.append({'name':name,'mesh':len(glmeshes)-1,'skin':0,'extras':{'sourceMode':'native-authored-v5','sourceVertexCount':count,'sourceTriangles':len(ix)//3,'morphNames':dict(zip(morphnames,range(len(morphnames))))}})
        reports[name]={'vertices':count,'triangles':len(ix)//3,'morphNames':morphnames,'attributes':list(a),'sourceIDPolicy':'exact UV-split baseline/native vertex ID; socks replaced by explicit660+66 map'}
    g={'asset':{'version':'2.0','generator':'build-football-native-player.py source-ID V5'},'scene':0,'scenes':[{'nodes':[0]+list(range(49,len(nodes)))}],'nodes':nodes,'skins':[{'name':'Production49','joints':list(range(49)),'skeleton':0,'inverseBindMatrices':ibm}],'meshes':glmeshes,'buffers':[{'byteLength':len(buffer)}],'bufferViews':views,'accessors':accessors}
    js=json.dumps(g,separators=(',',':')).encode();js+=b' '*((-len(js))%4);blob=struct.pack('<III',0x46546c67,2,12+8+len(js)+8+len(buffer))+struct.pack('<I4s',len(js),b'JSON')+js+struct.pack('<I4s',len(buffer),b'BIN\0')+buffer
    assert sum(v['vertices'] for v in reports.values())==25599
    assert sum(v['triangles'] for v in reports.values())==34007
    out.mkdir(parents=True,exist_ok=True);(out/'native-player-v5.glb').write_bytes(blob)
    manifest={'schemaVersion':1,'mode':'native-authored-v5','assetSHA256':hashlib.sha256(blob).hexdigest(),'sourceJSONSHA256':SOURCE_SHA,'baselineJSONSHA256':sha(baseline),'nativeBlendSHA256':'196402fdca7bd447459412333698100e3ed36c7a59a73a0ff0d8aee04e6e76da','evidenceZIPSHA256':'11f0931ae129706288e29533b812f4eeae7a339553c5779ed654c1c7fc4804ca','surfaces':reports,'drivers':drivers,'socks':{k:s['sockTopology'][k] for k in ['originalVertexMap','newVertices']},'restoredBodyTriangles':s['visibleMaskEdit']['addedOriginalSourceTriangles'],'normalPolicy':'area normals on changed neutral/morph patch and immediate neighbours, welded only equivalent smooth corners; original face/neck normals and eight facial normal channels retained','exclusions':['preview root/ground','hidden65rig','native leg/root tracks','241 boot reference keys','legacy CPU body/cloth/sock fairing'],'runtimeOwnership':'body/jersey/shorts/socks adopted; unchanged current face/hair/brows and accepted generated dynamic boots remain owned by existing renderer','limits':['Source numerical authoring, no new artist work','73.156mm follow-through overlap remains open','Browser and physical-device acceptance separate']}
    (out/'native-player-v5-provenance.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'assetSHA256':manifest['assetSHA256'],'bytes':len(blob),'surfaces':{k:[v['vertices'],v['triangles']] for k,v in reports.items()}}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--baseline',type=Path,required=True);p.add_argument('--output',type=Path,default=ROOT/'apps/web/public/models/football');a=p.parse_args();export(a.baseline,a.output)
