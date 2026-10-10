// Lossless GLB pruning. Usage: node scripts/assets/pack-derby-models.mjs SOURCE_DIR
// Source commit and license are recorded in docs/games/derby-visual-assets.md.
import fs from 'node:fs';
import path from 'node:path';
const source = process.argv[2];
if (!source) throw new Error('Supply the directory containing the two source GLBs');
for (const [input, output, keep] of [
  ['horse-animations.glb', 'horse.glb', ['Run', 'Idle']],
  ['human-base-animations.glb', 'jockey.glb', []],
]) {
  const bytes = fs.readFileSync(path.join(source, input));
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binary = bytes.subarray(28 + jsonLength);
  gltf.animations = gltf.animations.filter(a => keep.includes(a.name));
  const accessors = new Set();
  for (const mesh of gltf.meshes) for (const p of mesh.primitives) {
    Object.values(p.attributes).forEach(a => accessors.add(a));
    if (p.indices !== undefined) accessors.add(p.indices);
    for (const target of p.targets || []) Object.values(target).forEach(a => accessors.add(a));
  }
  for (const s of gltf.skins || []) if (s.inverseBindMatrices !== undefined) accessors.add(s.inverseBindMatrices);
  for (const a of gltf.animations) for (const s of a.samplers) {accessors.add(s.input);accessors.add(s.output);}
  const ids = [...accessors].sort((a,b) => a-b), remap = new Map(ids.map((id,i) => [id,i]));
  for (const mesh of gltf.meshes) for (const p of mesh.primitives) {
    for (const key in p.attributes) p.attributes[key] = remap.get(p.attributes[key]);
    if (p.indices !== undefined) p.indices = remap.get(p.indices);
    for (const target of p.targets || []) for (const key in target) target[key] = remap.get(target[key]);
  }
  for (const s of gltf.skins || []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = remap.get(s.inverseBindMatrices);
  for (const a of gltf.animations) for (const s of a.samplers) {s.input=remap.get(s.input);s.output=remap.get(s.output);}
  gltf.accessors = ids.map(i => gltf.accessors[i]);
  const views = new Set(gltf.accessors.map(a => a.bufferView));
  for (const image of gltf.images || []) if (image.bufferView !== undefined) views.add(image.bufferView);
  const viewIds=[...views].sort((a,b)=>a-b), viewMap=new Map(viewIds.map((id,i)=>[id,i]));
  for (const a of gltf.accessors) a.bufferView=viewMap.get(a.bufferView);
  for (const image of gltf.images || []) if (image.bufferView !== undefined) image.bufferView=viewMap.get(image.bufferView);
  let offset=0;
  const chunks=[];
  gltf.bufferViews=viewIds.map(id=>{
    const view=gltf.bufferViews[id], chunk=binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);
    const result={...view,buffer:0,byteOffset:offset};
    chunks.push(chunk,Buffer.alloc((4-chunk.length%4)%4));offset+=chunk.length+(4-chunk.length%4)%4;
    return result;
  });
  gltf.buffers=[{byteLength:offset}];
  const raw=Buffer.from(JSON.stringify(gltf));
  const json=Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,32)]), bin=Buffer.concat(chunks);
  const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
  const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(bin.length);binHeader.writeUInt32LE(0x004e4942,4);
  const dest=path.join('apps/web/public/models/derby',output);
  fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,Buffer.concat([header,json,binHeader,bin]));
  console.log(output,fs.statSync(dest).size,'bytes');
}
