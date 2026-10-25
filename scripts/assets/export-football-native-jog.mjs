import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const expected = 'f5d4b6bb8911693eccd798d83fff2c0be5cdca3c74038f83902b0925736c8422';
const source = process.argv[2];
if (!source) throw new Error('Supply the verified evidence motion/v3/jog-controls.json path');
const bytes = readFileSync(source);
if (createHash('sha256').update(bytes).digest('hex') !== expected)
  throw new Error('Native controls source SHA mismatch');
const data = JSON.parse(bytes);
const keys = [
  'pelvisLocalPositionMetres',
  'pelvisQuaternion',
  'upperBodyAndHands',
  'kneePoleRootSpace',
];
const result = Object.fromEntries(
  [
    'format',
    'referenceSpeed',
    'referenceStride',
    'canonicalCoordinates',
    'channelSemantics',
    'interpolation',
    'sourceBlendSHA256',
    'sourceGLBSHA256',
    'canonicalRestSha256',
  ].map((key) => [key, data[key]])
);
result.sourceControlsSHA256 = expected;
result.samples = data.samples.map((sample) => ({
  phase: sample.phase,
  ...Object.fromEntries(keys.map((key) => [key, sample[key]])),
  tangentsPerPhase: Object.fromEntries(keys.map((key) => [key, sample.tangentsPerPhase[key]])),
}));
const destination = fileURLToPath(
  new URL('../../apps/web/src/components/football/engine/native-jog-controls.json', import.meta.url)
);
const output = JSON.stringify(result) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== output)
    throw new Error('Native controls export differs');
} else writeFileSync(destination, output);
console.log(
  `${process.argv.includes('--check') ? 'Verified' : 'Exported'} ${data.samples.length} semantic native controls; source ${expected}`
);
