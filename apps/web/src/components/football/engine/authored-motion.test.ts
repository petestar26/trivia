import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyAuthoredMotion, AUTHORED_CONTACT_MARKERS, AUTHORED_MOTION_NAMES,
  AUTHORED_MOTION_PROVENANCE, createAuthoredBodyClip, sampleAuthoredControl,
} from './authored-motion';
import packed from './authored-motion-clips.json';
import { createRig, DIM, kitFromClub, lookGeometry, type Rig } from './rig';
import { KICK, DIVE_CONTACT, DIVE_DURATION, kickGeometry, poseKick, poseKeeperDive, diveRoot, resetPose } from './poses';
import { directorFrame, GOAL_SEQUENCE } from './director';
function rig(): Rig {
  const look = lookGeometry({ kit: kitFromClub({primary:'#e01434',secondary:'#fff',pattern:'solid'}),skin:'#c79572',hair:'#222' });
  return createRig(new THREE.MeshBasicMaterial(), look.geometry);
}
const wp=(r:Rig,name:'footL'|'footR'|'toeL'|'toeR'|'handL'|'handR')=>r.bones[name].getWorldPosition(new THREE.Vector3());

describe('original authored asset pipeline', () => {
  it('exports native rig animation tracks with named authoring decisions and reproducible source identity', () => {
    expect(AUTHORED_MOTION_NAMES).toEqual(expect.arrayContaining(['run','acceleration','plantedTurn','kick','keeperDive','celebrate','runSwing']));
    const bytes=readFileSync('src/components/football/engine/authored-motion-source.json');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(AUTHORED_MOTION_PROVENANCE.sourceSha256);
    const portable=JSON.parse(readFileSync('public/models/football/original-authored-motion.json','utf8'));
    expect(portable).toEqual(packed);
    for(const name of AUTHORED_MOTION_NAMES.filter(name=>name!=='runSwing')){
      const clip=createAuthoredBodyClip(name);
      expect(clip.tracks.filter(track=>track instanceof THREE.QuaternionKeyframeTrack)).toHaveLength(19);
      expect(clip.tracks.every(track=>track.validate())).toBe(true);
      expect(packed.clips.find(definition=>definition.clip.name===name)!.intents.length).toBeGreaterThan(2);
    }
  });
  it('actually plays authored joints through a native AnimationMixer, independently of the contact wrapper',()=>{
    const native=rig(),sampled=rig();resetPose(native);resetPose(sampled);
    const mixer=new THREE.AnimationMixer(native.root);
    const action=mixer.clipAction(createAuthoredBodyClip('run'));
    action.setLoop(THREE.LoopOnce,1);action.play();mixer.setTime(.12);
    const expected=new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(23),THREE.MathUtils.degToRad(-6),THREE.MathUtils.degToRad(11),'YXZ'));
    expect(native.bones.upperArmL.quaternion.clone().normalize().angleTo(expected)).toBeLessThan(1e-5);
    applyAuthoredMotion(sampled,'run',.12);
    for(const bone of packed.bodyBones){
      expect((native.bones as Record<string,THREE.Bone>)[bone].quaternion.clone().normalize().angleTo((sampled.bones as Record<string,THREE.Bone>)[bone].quaternion)).toBeLessThan(1e-5);
    }
    const otherBefore=sampled.bones.upperArmL.quaternion.clone();
    mixer.setTime(.37);
    expect(native.bones.upperArmL.quaternion.angleTo(otherBefore)).toBeGreaterThan(.5);
    expect(sampled.bones.upperArmL.quaternion.angleTo(otherBefore)).toBeLessThan(1e-6);
    mixer.stopAllAction();mixer.uncacheRoot(native.root);native.dispose();sampled.dispose();
  });
  it('uses an authored anticipation and a different follow-through, and mirrors the actual striking side',()=>{
    const a=rig(),b=rig();resetPose(a);resetPose(b);
    applyAuthoredMotion(a,'kick',.18);const wind=a.bones.chest.quaternion.clone();
    applyAuthoredMotion(a,'kick',.45);
    expect(a.bones.chest.quaternion.angleTo(wind)).toBeGreaterThan(.5);
    applyAuthoredMotion(b,'kick',.45,{mirror:true});
    const right=a.bones.upperArmR.quaternion;
    const expected=new THREE.Quaternion(right.x,-right.y,-right.z,right.w);
    expect(b.bones.upperArmL.quaternion.angleTo(expected)).toBeLessThan(1e-5);
    a.dispose();b.dispose();
  });
  it('samples authored curves without history or frame-delta dependence and closes the gait seam',()=>{
    const a=rig(),b=rig();
    for(let t=0;t<.71;t+=1/60){resetPose(a);applyAuthoredMotion(a,'run',t);}
    resetPose(a);applyAuthoredMotion(a,'run',.71);resetPose(b);applyAuthoredMotion(b,'run',.71);
    for(const name of packed.bodyBones) expect((a.bones as Record<string,THREE.Bone>)[name].quaternion.angleTo((b.bones as Record<string,THREE.Bone>)[name].quaternion)).toBeLessThan(1e-6);
    resetPose(a);applyAuthoredMotion(a,'run',0);resetPose(b);applyAuthoredMotion(b,'run',1);
    expect(a.bones.upperArmL.quaternion.angleTo(b.bones.upperArmL.quaternion)).toBeLessThan(1e-6);
    expect(sampleAuthoredControl('runSwing','footTarget',0)).toEqual([0,0,0]);
    expect(sampleAuthoredControl('runSwing','footTarget',1)).toEqual([0,0,1]);
    expect(sampleAuthoredControl('runSwing','footTarget',.5)[1]).toBeCloseTo(1.12,5);
    const eps=1e-5;
    const velocity=(sampleAuthoredControl('runSwing','footTarget',eps,{start:[0,0,-2]})[2]-sampleAuthoredControl('runSwing','footTarget',0)[2])/eps;
    expect(velocity).toBeCloseTo(-2,2);
    a.dispose();b.dispose();
  });
  it('blends an authored posture without moving a protected support pelvis translation',()=>{
    const r=rig();resetPose(r);r.bones.hips.position.set(.02,.79,-.03);
    const before=r.bones.hips.position.clone(),from=r.bones.upperArmL.quaternion.clone();
    applyAuthoredMotion(r,'run',.37,{weight:.5,preserveHipsPosition:true});
    const half=r.bones.upperArmL.quaternion.clone();
    expect(half.angleTo(from)).toBeGreaterThan(.1);
    expect(r.bones.hips.position.distanceTo(before)).toBeLessThan(1e-12);
    applyAuthoredMotion(r,'run',.37,{preserveHipsPosition:true});
    expect(r.bones.upperArmL.quaternion.angleTo(half)).toBeCloseTo(half.angleTo(from),5);
    r.dispose();
  });
});

describe('authored motion contact and released-event boundaries',()=>{
  it('locks the original marker times and does not turn clip metadata into a new director clock',()=>{
    expect(AUTHORED_CONTACT_MARKERS).toEqual({kick:.3,keeper:.45,goal:2.05});
    expect(KICK.contact).toBe(.3);expect(DIVE_CONTACT).toBe(.45);expect(DIVE_DURATION).toBe(1.8);expect(GOAL_SEQUENCE.moment).toBe(2.05);
    const input={matchKey:'vf-s1-w05-f01',status:'FIRST_HALF' as const,goals:[{n:1,side:'H' as const,atMs:6000}],fullTime:null};
    expect(directorFrame({...input,elapsedMs:8049}).goal!.scored).toBe(false);
    expect(directorFrame({...input,elapsedMs:8050}).goal!.scored).toBe(true);
    expect(directorFrame({...input,elapsedMs:5999}).goal).toBeNull();
  });
  for(const foot of ['L','R'] as const)for(const direction of [-1,1])for(const scale of [.96,1.04])
  it(`keeps authored ${foot} strike contact and support exact (${direction},scale${scale})`,()=>{
    const r=rig();r.root.scale.setScalar(scale);
    const spec={foot,ball:new THREE.Vector3(2,DIM.ballRadius,3),dir:new THREE.Vector3(direction,0,0),power:.9,loft:.2};
    const {root,plant}=kickGeometry(spec);r.root.position.copy(root);r.root.rotation.y=Math.atan2(spec.dir.x,spec.dir.z);
    const other=foot==='L'?'R':'L';
    for(const t of [0,.09,.18,.3,.45,.65,.85]){
      poseKick(r,t,spec);expect(wp(r,`foot${other}`).distanceTo(plant)).toBeLessThan(.03);
      if(t===KICK.contact)expect(wp(r,`toe${foot}`).distanceTo(spec.ball)).toBeLessThan(DIM.ballRadius+.1);
    }
    r.dispose();
  });
  for(const direction of [-1,1] as const)for(const scale of [.96,1.04])
  it(`keeps keeper interception and recovered height at the existing times (${direction},scale${scale})`,()=>{
    const r=rig();r.root.scale.setScalar(scale);const spec={direction,reach:1.3,height:1.1};
    const ball=new THREE.Vector3(direction*1.3,1.1,.4);
    r.root.position.copy(diveRoot(spec,DIVE_CONTACT));poseKeeperDive(r,DIVE_CONTACT,spec,ball);
    expect(Math.min(wp(r,'handL').distanceTo(ball),wp(r,'handR').distanceTo(ball))).toBeLessThan(.3);
    r.root.position.copy(diveRoot(spec,DIVE_DURATION));poseKeeperDive(r,DIVE_DURATION,spec,ball);
    expect(r.bones.hips.getWorldPosition(new THREE.Vector3()).y).toBeGreaterThan(.7);
    r.dispose();
  });
});
