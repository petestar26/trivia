import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachPlayerHead,
  disposeHairAssets,
  type HeadVisual,
  type PlayerDetail,
  type PlayerIdentity,
} from './player-appearance';
import { createRig } from './rig';

const identity: PlayerIdentity = {
  name: 'Test Player',
  seed: 0,
  skin: '#99633f',
  hair: '#161311',
  eye: '#597260',
  style: 0,
  nose: 0.2,
  lips: -0.15,
  ears: 0.1,
};
const names = [
  'blinkLeft',
  'blinkRight',
  'jawOpen',
  'browRaise',
  'smile',
  'noseWidth',
  'lipFullness',
  'earSize',
];
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
);

function head() {
  // Minimal nondegenerate scalp with the production eight-target contract. Three's
  // real updateMorphTargets resets its influence array when detail changes.
  const geometry = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.03, 1.78, 0, 0.03, 1.78, 0, 0, 1.78, 0.03], 3)
    );
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2]);
    g.morphTargetsRelative = true;
    g.morphAttributes.position = names.map((name) => {
      const attribute = new THREE.Float32BufferAttribute(new Float32Array(9), 3);
      attribute.name = name;
      return attribute;
    });
    g.userData.morphNames = Object.fromEntries(names.map((name, index) => [name, index]));
    return g;
  };
  const assets = { high: geometry(), mid: geometry(), low: geometry() };
  const material = new THREE.MeshBasicMaterial();
  const rig = createRig(material, assets.mid);
  const visual = attachPlayerHead(rig, assets, identity, material);
  cleanups.push(() => {
    visual.dispose();
    rig.dispose();
    disposeHairAssets(assets);
    Object.values(assets).forEach((g) => g.dispose());
    material.dispose();
  });
  return visual;
}

function weights(visual: HeadVisual) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      visual.mesh.morphTargetInfluences![visual.mesh.morphTargetDictionary![name]],
    ])
  );
}
function expected(detail: PlayerDetail, kind = 'idle', moving = false) {
  const active = moving && detail !== 'low';
  return {
    blinkLeft: active ? 1 : 0,
    blinkRight: active ? 1 : 0,
    jawOpen: active && kind === 'run' ? 0.08 : 0,
    browRaise: active && kind === 'celebrate' ? 0.2 : 0,
    smile: active && kind === 'celebrate' ? 0.28 : 0,
    noseWidth: identity.nose,
    lipFullness: identity.lips,
    earSize: identity.ears,
  };
}
function expectWeights(visual: HeadVisual, detail: PlayerDetail, kind?: string, moving?: boolean) {
  const actual = weights(visual);
  for (const [name, value] of Object.entries(expected(detail, kind, moving)))
    expect(actual[name], name).toBeCloseTo(value, 12);
}

const transitions: Array<[PlayerDetail, PlayerDetail]> = [
  ['mid', 'high'],
  ['high', 'mid'],
  ['mid', 'low'],
  ['low', 'mid'],
  ['high', 'low'],
  ['low', 'high'],
];

describe('player facial state across detail changes', () => {
  it('has identity and still expressions on the first rendered frame before animate', () => {
    const visual = head();
    expectWeights(visual, 'mid');
    for (const detail of ['high', 'low', 'mid'] as const) {
      visual.setDetail(detail);
      expectWeights(visual, detail);
    }
  });

  for (const [from, to] of transitions)
    for (const kind of ['run', 'celebrate'])
      it(`retains the current moving ${kind} state when ${from} changes to ${to} after animate`, () => {
        const visual = head();
        visual.setDetail(from);
        // This is the pool's production order: animation, detail selection, render.
        // Seed zero and time 0.1 put both eyelids at the blink peak.
        visual.animate(0.1, kind, true);
        expectWeights(visual, from, kind, true);
        visual.setDetail(to);
        expectWeights(visual, to, kind, true);
        visual.setDetail(from);
        expectWeights(visual, from, kind, true);
      });

  for (const [from, to] of transitions)
    it(`retains identity and reduced-motion stillness when ${from} changes to ${to}`, () => {
      const visual = head();
      visual.animate(0.1, 'celebrate', true);
      visual.setDetail(from);
      visual.animate(0.1, 'celebrate', false);
      visual.setDetail(to);
      expectWeights(visual, to);
      visual.setDetail(from);
      expectWeights(visual, from);
    });

  it('restores the latest low-detail animation state without a later animate call', () => {
    const visual = head();
    visual.animate(0.1, 'celebrate', true);
    visual.setDetail('low');
    visual.animate(0.1, 'run', true);
    expectWeights(visual, 'low');
    visual.setDetail('high');
    expectWeights(visual, 'high', 'run', true);
    visual.animate(0.4, 'idle', true);
    visual.setDetail('mid');
    expect(weights(visual)).toEqual({ ...expected('mid'), blinkLeft: 0, blinkRight: 0 });
  });
});
