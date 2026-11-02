/** Original offline LOD authoring for the individually pinned CC0 human.
 * node scripts/assets/build-football-bodies.mjs [--check]
 * No external asset download, animation import, Blender or runtime simplifier.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const req=createRequire(path.join(root,'apps/web/package.json'));
const esbuild=createRequire(req.resolve('vite/package.json'))('esbuild');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const sourcePath=path.join(root,'apps/web/public/models/derby/jockey.glb');
const sourceBytes=fs.readFileSync(sourcePath);
const SOURCE_SHA='0fde4cc25d0998a7e2f37db5f60109ce48bee9c0bd262b58786c013b54d16c80';
if(sha(sourceBytes)!==SOURCE_SHA)throw Error('Pinned CC0 jockey input mismatch');
const licensePath=path.join(root,'apps/web/public/models/derby/LICENSE-CC0.txt');
const licenseBytes=fs.readFileSync(licensePath);
const modules=['rig.ts','human-model.ts','body-surface.ts'];
const sourceHashes=Object.fromEntries(modules.map(name=>[name,sha(fs.readFileSync(path.join(root,'apps/web/src/components/football/engine',name)))]));
const humanSource=fs.readFileSync(path.join(root,'apps/web/src/components/football/engine/human-model.ts'),'utf8');
if(!humanSource.includes('hand|index|middle|ring|pinky|thumb'))throw Error('Need corrected metacarpal-to-hand retargeting before export');
const bundled=await esbuild.build({stdin:{contents:`export * as THREE from 'three'; export {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'; export {BONES,boneParent,restLocalPosition,restPosition,createRig,Region} from './src/components/football/engine/rig'; export {retargetHuman} from './src/components/football/engine/human-model'; export {extractFootballBody} from './src/components/football/engine/body-surface';`,resolveDir:path.join(root,'apps/web'),sourcefile:'football-body-authoring.ts'},bundle:true,write:false,platform:'node',format:'esm',target:'node18',logLevel:'silent'});
const scratch=path.join(os.tmpdir(),'playqube-football-authoring');fs.mkdirSync(scratch,{recursive:true});
const bundledPath=path.join(scratch,`body-runtime-${sha(bundled.outputFiles[0].contents).slice(0,12)}.mjs`);fs.writeFileSync(bundledPath,bundled.outputFiles[0].contents);
const rt=await import(pathToFileURL(bundledPath).href);const {THREE,GLTFLoader,BONES,Region}=rt;
if(BONES.length!==49)throw Error('Expected the production 49-bone rig');
// Strip image/material references from a scratch parse copy; no bitmap is imported.
const sourceJsonLength=sourceBytes.readUInt32LE(12),parseJson=JSON.parse(sourceBytes.subarray(20,20+sourceJsonLength));
for(const mesh of parseJson.meshes)for(const primitive of mesh.primitives)delete primitive.material;
for(const key of ['materials','textures','images','samplers'])delete parseJson[key];
let parseText=Buffer.from(JSON.stringify(parseJson));parseText=Buffer.concat([parseText,Buffer.alloc((4-parseText.length%4)%4,32)]);
const parseBin=sourceBytes.subarray(28+sourceJsonLength),parseHeader=Buffer.alloc(20),parseBinHeader=Buffer.alloc(8);parseHeader.write('glTF');parseHeader.writeUInt32LE(2,4);parseHeader.writeUInt32LE(28+parseText.length+parseBin.length,8);parseHeader.writeUInt32LE(parseText.length,12);parseHeader.writeUInt32LE(0x4e4f534a,16);parseBinHeader.writeUInt32LE(parseBin.length);parseBinHeader.writeUInt32LE(0x004e4942,4);
const parseBytes=Buffer.concat([parseHeader,parseText,parseBinHeader,parseBin]);
const gltf=await new GLTFLoader().parseAsync(parseBytes.buffer.slice(parseBytes.byteOffset,parseBytes.byteOffset+parseBytes.byteLength),'');
let sourceMesh;gltf.scene.traverse(o=>{if(o.isSkinnedMesh)sourceMesh=o;});if(!sourceMesh)throw Error('Missing pinned source skin');
const uncut=rt.retargetHuman(sourceMesh);uncut.geometry.setAttribute('authorY',new THREE.Float32BufferAttribute(Array.from(sourceMesh.geometry.getAttribute('position').array).filter((_,i)=>i%3===1),1));const body=rt.extractFootballBody(uncut);
const source=body.geometry,p=source.getAttribute('position'),joints=source.getAttribute('skinIndex'),weights=source.getAttribute('skinWeight');
const sourceIndex=Array.from(source.getIndex().array),used=[...new Set(sourceIndex)].sort((a,b)=>a-b),remap=new Map(used.map((s,i)=>[s,i]));
const triangles=sourceIndex.map(i=>remap.get(i));
const vertices=used.map(i=>({p:[p.getX(i),p.getY(i),p.getZ(i)],n:Array.from({length:3},(_,k)=>source.getAttribute('normal').getComponent(i,k)),j:Array.from({length:4},(_,k)=>joints.getComponent(i,k)),w:Array.from({length:4},(_,k)=>weights.getComponent(i,k)),region:body.region[i],uv:[body.uvShirt[i*2],body.uvShirt[i*2+1]],theta:body.theta[i],source:i}));
for(const v of vertices){v.dominant=v.j[v.w.indexOf(Math.max(...v.w))];if(v.w.some(x=>!Number.isFinite(x))||Math.abs(v.w.reduce((a,b)=>a+b,0)-1)>1e-5)throw Error('Source skin weight normalization');}
const boundsOf=v=>({min:[0,1,2].map(k=>Math.min(...v.map(x=>x.p[k]))),max:[0,1,2].map(k=>Math.max(...v.map(x=>x.p[k])))});
const highBounds=boundsOf(vertices),byBone=new Map();vertices.forEach((v,i)=>{if(!byBone.has(v.dominant))byBone.set(v.dominant,[]);byBone.get(v.dominant).push(i)});
const protectedVertices=new Set();
for(const ids of byBone.values())for(let k=0;k<3;k++){let lo=ids[0],hi=ids[0];for(const i of ids){if(vertices[i].p[k]<vertices[lo].p[k])lo=i;if(vertices[i].p[k]>vertices[hi].p[k])hi=i}protectedVertices.add(lo);protectedVertices.add(hi)}
function cluster(cell,lod){
 const buckets=new Map(),map=new Array(vertices.length),clusters=[];
 vertices.forEach((v,i)=>{
  // Smaller local cells preserve hand/finger separation and loaded boot silhouette.
  const finger=v.dominant>=19,foot=v.region===Region.BOOT;
  const scale=finger?.25:foot?.5:1,step=cell*scale;
  const seam=v.uv[0]<.15?'lo':v.uv[0]>.85?'hi':'main';
  const blend=Math.floor(Math.max(...v.w)*5);
  const key=protectedVertices.has(i)?`protected:${i}`:`${v.dominant}:${v.region}:${seam}:${blend}:${v.p.map((x,k)=>Math.floor((x-highBounds.min[k])/step)).join(':')}`;
  let group=buckets.get(key);if(!group){group={id:clusters.length,members:[],key};clusters.push(group);buckets.set(key,group)}group.members.push(i);map[i]=group.id;
 });
 const out=clusters.map(group=>{
  const members=group.members.map(i=>vertices[i]),n=members.length,weightMap=new Map();
  members.forEach(v=>v.w.forEach((w,k)=>weightMap.set(v.j[k],(weightMap.get(v.j[k])??0)+w/n)));
  const skin=[...weightMap].filter(([,w])=>w>1e-8).sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,4),total=skin.reduce((s,[,w])=>s+w,0);
  const j=Array(4).fill(0),w=Array(4).fill(0);skin.forEach(([bone,weight],k)=>{j[k]=bone;w[k]=weight/total});
  const nrm=[0,1,2].map(k=>members.reduce((sum,v)=>sum+v.n[k],0)/n),normalLength=Math.hypot(...nrm);nrm.forEach((_,k)=>nrm[k]/=normalLength);
  return{n:nrm,p:[0,1,2].map(k=>members.reduce((s,v)=>s+v.p[k],0)/n),j,w,region:members[0].region,uv:[0,1].map(k=>members.reduce((s,v)=>s+v.uv[k],0)/n),theta:Math.atan2(members.reduce((s,v)=>s+Math.sin(v.theta),0),members.reduce((s,v)=>s+Math.cos(v.theta),0)),members:group.members,dominant:members[0].dominant};
 });
 const ix=[],seen=new Set();for(let k=0;k<triangles.length;k+=3){const tri=triangles.slice(k,k+3).map(i=>map[i]);if(new Set(tri).size!==3)continue;const key=[...tri].sort((a,b)=>a-b).join(',');if(seen.has(key))continue;seen.add(key);ix.push(...tri)}
 return{vertices:out,indices:ix,map,cell,lod};
}
function choose(lod,target){let lo=.002,hi=.18,best;for(let step=0;step<22;step++){const cell=(lo+hi)/2,result=cluster(cell,lod);if(!best||Math.abs(result.indices.length/3-target)<Math.abs(best.indices.length/3-target))best=result;if(result.indices.length/3>target)lo=cell;else hi=cell;}return best;}
const levels=[{lod:'high',vertices:vertices.map((v,i)=>({...v,members:[i]})),indices:triangles,map:vertices.map((_,i)=>i),cell:0},choose('mid',6000),choose('low',2800)];
function geometry(level){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(level.vertices.flatMap(v=>v.p),3));g.setIndex(level.indices);g.setAttribute('normal',new THREE.Float32BufferAttribute(level.vertices.flatMap(v=>v.n),3));return g;}
function writeGlb(level){
 const g=geometry(level),chunks=[],views=[],accessors=[];let offset=0;
 function attribute(array,type,component=5126,minmax=false){const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad}const typed=component===5126?new Float32Array(array):new Uint16Array(array),bytes=Buffer.from(typed.buffer);views.push({buffer:0,byteOffset:offset,byteLength:bytes.length});chunks.push(bytes);offset+=bytes.length;const width={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[type],a={bufferView:views.length-1,componentType:component,count:array.length/width,type};if(minmax){a.min=Array.from({length:width},(_,k)=>Math.min(...array.filter((_,i)=>i%width===k)));a.max=Array.from({length:width},(_,k)=>Math.max(...array.filter((_,i)=>i%width===k)))}accessors.push(a);return accessors.length-1;}
 const attrs={POSITION:attribute(level.vertices.flatMap(v=>v.p),'VEC3',5126,true),NORMAL:attribute(Array.from(g.getAttribute('normal').array),'VEC3'),JOINTS_0:attribute(level.vertices.flatMap(v=>v.j),'VEC4',5123),WEIGHTS_0:attribute(level.vertices.flatMap(v=>v.w),'VEC4'),TEXCOORD_0:attribute(level.vertices.flatMap(v=>v.uv),'VEC2'),_REGION:attribute(level.vertices.map(v=>v.region),'SCALAR'),_THETA:attribute(level.vertices.map(v=>v.theta),'SCALAR')};const ia=attribute(level.indices,'SCALAR',5123);
 const bind=BONES.flatMap(name=>new THREE.Matrix4().makeTranslation(...rt.restPosition(name).toArray()).invert().toArray());const ba=attribute(bind,'MAT4');
 const nodes=[{name:`Fictional football body ${level.lod}`,mesh:0,skin:0},...BONES.map(name=>({name,translation:rt.restLocalPosition(name).toArray()}))];
 BONES.forEach((name,i)=>{const parent=rt.boneParent(name);if(parent){const node=nodes[BONES.indexOf(parent)+1];(node.children??=[]).push(i+1)}});
 const extras={lod:level.lod,rig:'PlayQube R49 original runtime rest rig',boneNames:BONES,coordinateSpace:'metres; production world rest; +Z forward/+Y up',clusterCellMetres:level.cell,surfaceTrianglesBeforeLOD:triangles.length/3,originalSourceTriangles:sourceMesh.geometry.getIndex().count/3,protectedExtremaVertices:protectedVertices.size,sourceSHA256:SOURCE_SHA,visualSoleProfile:{ankleY:.08,soleY:.01,heelZ:-.07,ballZ:.15,toeZ:.20,toeUpSlope:Math.tan(.85)},attributeContract:'_REGION and _THETA retained; TEXCOORD_0 is uvShirt; skin has four normalized weights over 49 production bones'};
 const binary=Buffer.concat([...chunks,Buffer.alloc((4-offset%4)%4)]),j={asset:{version:'2.0',generator:'Original PlayQube offline skinned-body LOD authoring v1',extras:{sourcePackedSHA256:SOURCE_SHA,sourceLicense:'CC0-1.0'}},scene:0,scenes:[{nodes:[0,1]}],nodes,meshes:[{name:`PlayerBody-${level.lod}`,extras,primitives:[{attributes:attrs,indices:ia}]}],skins:[{name:'PlayQube original independent 49-bone rig',inverseBindMatrices:ba,joints:BONES.map((_,i)=>i+1),skeleton:1}],buffers:[{byteLength:binary.length}],bufferViews:views,accessors};
 let json=Buffer.from(JSON.stringify(j));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);const header=Buffer.alloc(20),binHeader=Buffer.alloc(8);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);binHeader.writeUInt32LE(binary.length);binHeader.writeUInt32LE(0x004e4942,4);g.dispose();return{bytes:Buffer.concat([header,json,binHeader,binary]),extras};
}
const output=path.join(root,'apps/web/public/models/football'),reports=[];fs.mkdirSync(output,{recursive:true});
for(const level of levels){const {bytes,extras}=writeGlb(level),file=`player-body-${level.lod}.glb`;if((process.argv.includes('--check')||process.argv.includes('--manifest-only'))){if(!fs.readFileSync(path.join(output,file)).equals(bytes))throw Error(`Body export drift: ${file}`)}else fs.writeFileSync(path.join(output,file),bytes);reports.push({file,sha256:sha(bytes),bytes:bytes.length,vertices:level.vertices.length,triangles:level.indices.length/3,bounds:boundsOf(level.vertices),...extras});console.log(JSON.stringify(reports.at(-1)));}
const manifest={schemaVersion:1,authoringScriptSHA256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),runtimeSourceSHA256:sourceHashes,sources:[{asset:'Mesh2Motion core human geometry, packed jockey.glb',file:'/models/derby/jockey.glb',sha256:SOURCE_SHA,upstreamCommit:'653a9698f5f315523072f1c3ff3496100401317b',upstreamSource:'https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/static/animations/human-base-animations.glb',upstreamSHA256:'406eb0a8dc4ab366e623b79b6e3005a4951392e1bda78ae39c1099d31147733c',license:'CC0-1.0',licenseURL:'https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/LICENSE-CC0.MD',licenseSHA256:sha(licenseBytes),retainedLicenseFile:'/models/derby/LICENSE-CC0.txt',licenseVerified:'2026-10-15 exact pinned license explicitly covers all 3D models/rigs/animations; no upstream application source imported'}],originalAdditions:['Production 49-bone retargeting with articulated finger anchors','Original dominant-bone/region/UV-seam vertex clustering and extrema protection','Original bone-aware neck cut, upper-clavicle compression, flexible neck seal and crew collar','Original source-height plane-split clothing regions and visual sole/heel/toe fit','Local GLB writer, new production bind skeleton/inverse binds and preserved material metadata'],reproduce:'node scripts/assets/build-football-bodies.mjs; --check compares all generated bytes',exportSteps:['Verify packed pinned source SHA-256 and retain its separately documented core CC0 license.','GLTFLoader parse; production retargetHuman and extractFootballBody; compact only referenced body vertices.','Bone-aware neck clipping, original flex neck/crew collar, clean original-source-Y material boundary subdivision, upper-clavicle compression and visual sole fit; mid/low cluster offline by dominant bone, region, UV wrap side and blend-weight band.','Protect six per-dominant-bone extrema and use finer hand/finger/foot cells; aggregate four normalized skin weights.','Fit visual shoe to ankle .08m, sole .01m, heel -.07m and toe +.20m; raise forward sole beyond fixed BALL z=.15 by tan(.85) for push-off, without moving contact rig bones.','Write production 49-bone local rest hierarchy and inverse binds with _REGION/_THETA/TEXCOORD_0 metadata.','Validate source identity, geometry, bounds, skin invariance and posed deformation independently.'],exports:reports,limits:['Original real-time anatomical source, not scans, mocap, simulated cloth or real-person likenesses.','LOD vertex averaging changes small surface details; high is retained for close-ups.','Surface-contact probes are separate from skeletal contact/IK correctness and physical-device acceptance.']};
if(!process.argv.includes('--check'))fs.writeFileSync(path.join(output,'player-body-provenance.json'),JSON.stringify(manifest,null,2)+'\n');
// Make the source-to-cluster map available for independent deformation error probes only.
fs.writeFileSync(path.join(scratch,'body-cluster-mapping.json'),JSON.stringify({sourceVertices:vertices,levels:levels.map(l=>({lod:l.lod,map:l.map,cell:l.cell,indices:l.indices}))}));
