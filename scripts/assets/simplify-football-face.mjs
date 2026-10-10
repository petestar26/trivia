// Simplify only the CC0 face asset for 23 live players. Run after pack-football-face.py.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const T = await import(require.resolve('three'));
const { SimplifyModifier } = await import(
  require.resolve('three/addons/modifiers/SimplifyModifier.js')
);
const path = 'apps/web/public/models/football/face.glb',
  bytes = fs.readFileSync(path);
const n = bytes.readUInt32LE(12),
  j = JSON.parse(bytes.subarray(20, 20 + n)),
  bin = bytes.subarray(28 + n);
const attr = (index) => {
  const a = j.accessors[index],
    v = j.bufferViews[a.bufferView],
    b = Uint8Array.from(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength));
  return a.componentType === 5126 ? new Float32Array(b.buffer) : new Uint16Array(b.buffer);
};
const g = new T.BufferGeometry();
g.setAttribute('position', new T.BufferAttribute(attr(0), 3));
g.setIndex(new T.BufferAttribute(attr(1), 1));
const out = new SimplifyModifier().modify(g, g.getAttribute('position').count - 1200);
out.computeBoundingBox();
const p = out.getAttribute('position'),
  ix = out.getIndex(),
  pb = Buffer.from(p.array.buffer, p.array.byteOffset, p.array.byteLength),
  ib = Buffer.from(new Uint16Array(ix.array).buffer);
const binary = Buffer.concat([pb, ib, Buffer.alloc((4 - (ib.length % 4)) % 4)]);
j.buffers = [{ byteLength: binary.length }];
j.bufferViews = [
  { buffer: 0, byteOffset: 0, byteLength: pb.length },
  { buffer: 0, byteOffset: pb.length, byteLength: ib.length },
];
j.accessors = [
  {
    bufferView: 0,
    componentType: 5126,
    count: p.count,
    type: 'VEC3',
    min: out.boundingBox.min.toArray(),
    max: out.boundingBox.max.toArray(),
  },
  { bufferView: 1, componentType: 5123, count: ix.count, type: 'SCALAR' },
];
const text = Buffer.from(JSON.stringify(j)),
  json = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]),
  header = Buffer.alloc(20),
  bh = Buffer.alloc(8);
header.write('glTF');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + json.length + binary.length, 8);
header.writeUInt32LE(json.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
bh.writeUInt32LE(binary.length);
bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(path, Buffer.concat([header, json, bh, binary]));
console.log({ vertices: p.count, triangles: ix.count / 3, bytes: fs.statSync(path).size });
