/** Reproducibly export original authored keys; never imports or samples procedural poses. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/web/package.json'));
const THREE = require('three');
const sourcePath = path.join(root, 'apps/web/src/components/football/engine/authored-motion-source.json');
const bytes = fs.readFileSync(sourcePath);
const source = JSON.parse(bytes);
const bodyBones = Object.keys(source.clips.find((c) => c.name === 'run').keys[0].rotationsDegrees);
// Smooth the authored handles, not an old animation function. Monotone slopes preserve
// pose extrema; dense native quaternion keys keep the bundle playable in AnimationMixer.
function sampledRotation(definition, bone) {
  const keys = definition.keys, count = keys.length;
  const same = keys.every((key) => key.rotationsDegrees[bone].every((v, axis) => v === keys[0].rotationsDegrees[bone][axis]));
  if (same) return { times: [0, definition.duration], angles: [keys[0].rotationsDegrees[bone], keys[0].rotationsDegrees[bone]] };
  const tangent = (index, axis) => {
    if (definition.loop && index === count - 1) index = 0;
    if (!definition.loop && (index === 0 || index === count - 1)) return 0;
    const before = index === 0 ? keys[count - 2] : keys[index - 1];
    const current = keys[index], after = keys[index + 1];
    const leftSpan = index === 0 ? definition.duration - before.time : current.time - before.time;
    const rightSpan = after.time - current.time;
    const left = (current.rotationsDegrees[bone][axis] - before.rotationsDegrees[bone][axis]) / leftSpan;
    const right = (after.rotationsDegrees[bone][axis] - current.rotationsDegrees[bone][axis]) / rightSpan;
    if (left * right <= 0) return 0;
    const w1 = 2 * rightSpan + leftSpan, w2 = rightSpan + 2 * leftSpan;
    return (w1 + w2) / (w1 / left + w2 / right);
  };
  const times = [], angles = [];
  for (let i = 0; i < count - 1; i++) for (let step = 0; step < 4; step++) {
    const a = keys[i], b = keys[i + 1], span = b.time - a.time, u = step / 4, u2 = u * u, u3 = u2 * u;
    times.push(a.time + span * u);
    angles.push(a.rotationsDegrees[bone].map((v, axis) =>
      (2 * u3 - 3 * u2 + 1) * v + (u3 - 2 * u2 + u) * tangent(i, axis) * span
      + (-2 * u3 + 3 * u2) * b.rotationsDegrees[bone][axis] + (u3 - u2) * tangent(i + 1, axis) * span));
  }
  times.push(keys.at(-1).time); angles.push(keys.at(-1).rotationsDegrees[bone]);
  return { times, angles };
}
const packed = source.clips.map((definition) => {
  const tracks = [];
  const times = definition.keys.map((k) => k.time);
  if (times.some((t, i) => !Number.isFinite(t) || i && t <= times[i - 1])) throw Error('Unordered authored key times');
  for (const bone of bodyBones) {
    if (!definition.keys.length) continue;
    const sampled = sampledRotation(definition, bone);
    const values = sampled.angles.flatMap((degrees) => {
      if (!degrees || degrees.length !== 3 || !degrees.every(Number.isFinite)) throw Error(`Missing authored bone ${bone}`);
      return new THREE.Quaternion().setFromEuler(new THREE.Euler(...degrees.map(THREE.MathUtils.degToRad), source.rotationOrder)).toArray();
    });
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, sampled.times, values));
  }
  if (times.length) tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, definition.keys.flatMap((k) => k.hipPosition)));
  for (const [name, control] of Object.entries(definition.controls)) {
    if (control.dimension === 3) tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, control.keys.map((k) => k[0]), control.keys.flatMap((k) => k[1]), THREE.InterpolateSmooth));
    if (control.dimension === 1) tracks.push(new THREE.NumberKeyframeTrack(`${name}.value`, control.keys.map((k) => k[0]), control.keys.flatMap((k) => k[1]), THREE.InterpolateSmooth));
  }
  const clip = new THREE.AnimationClip(definition.name, definition.duration, tracks);
  const hash = crypto.createHash('sha256').update(`playqube-authored-motion:${definition.name}`).digest('hex');
  clip.uuid = `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  return { clip: clip.toJSON(), loop: definition.loop, markers: definition.markers, intents: definition.keys.map(({time,intent}) => ({time,intent})), controls: definition.controls };
});
const output = { format: 'playqube-original-animation-clip-bundle-v1', sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'), rig: source.rig, bodyBones, origin: source.origin, rotationOrder: source.rotationOrder, rotationInterpolation: source.rotationInterpolation, runtimeContactBoundary: source.runtimeContactBoundary, contactMarkers: source.contactMarkers, clips: packed };
const serialized = JSON.stringify(output) + '\n';
const paths = ['apps/web/src/components/football/engine/authored-motion-clips.json','apps/web/public/models/football/original-authored-motion.json'];
for (const destination of paths) {
  const target = path.join(root, destination);
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== serialized) throw Error(`Authored export drift: ${destination}`);
  } else fs.writeFileSync(target, serialized);
}
console.log(JSON.stringify({clips: packed.length, bodyBones: bodyBones.length, bytes: Buffer.byteLength(serialized), sourceSha256: output.sourceSha256, files: paths, check: process.argv.includes('--check')}));
