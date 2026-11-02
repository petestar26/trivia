"""Geometric hand and relative-arm diagnostics, not Euler-axis acceptance."""
from pathlib import Path
import json,math,hashlib
P=Path(__file__).resolve().parent
rest=json.loads((P.parent/'verified-source/reference-clip-contact-manifest.json').read_text())['rig']['restBones']
def add(a,b):return [a[i]+b[i] for i in range(3)]
def sub(a,b):return [a[i]-b[i] for i in range(3)]
def dot(a,b):return sum(x*y for x,y in zip(a,b))
def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def mul(a,b):return [a[0]*b[0]-dot(a[1:],b[1:]),*add(add([a[0]*v for v in b[1:]],[b[0]*v for v in a[1:]]),cross(a[1:],b[1:]))]
def rotate(q,v):return mul(mul(q,[0,*v]),[q[0],-q[1],-q[2],-q[3]])[1:]
def unit(a):
 length=math.sqrt(dot(a,a));return [x/length for x in a]
def native(v):return [v[0],-v[2],v[1]]
def angle(q):return math.degrees(2*math.acos(max(-1,min(1,abs(q[0])/math.sqrt(dot(q,q))))))
report={'scope':'Rest-plane geometric hand diagnostics; dorsal positive away from palm, flex positive toward palm. Euler component similarity is not a correctness test.','versions':{}}
for version in ['v2','v3']:
 poses=json.loads((P/version/'native-jog-local-poses.json').read_text())['samples'];controls=json.loads((P/version/'jog-controls.json').read_text());results={};elbows={}
 for side in ['L','R']:
  hand=native(rest['hand'+side]['worldMetres']);idx=sub(native(rest['index1'+side]['worldMetres']),hand);pink=sub(native(rest['pinky1'+side]['worldMetres']),hand);normal=unit(cross(idx,pink));normal=[v*(-1 if side=='R' else 1) for v in normal]
  fingers={}
  for digit in ['thumb','index','middle','ring','pinky']:
   joints={}
   for j in [1,2,3]:
    name=digit+str(j)+side;nxt=digit+str(j+1)+side if j<3 else name;prev=name if j<3 else digit+'2'+side;direction=unit(sub(native(rest[nxt]['worldMetres']),native(rest[prev]['worldMetres'])));volar=[-v for v in normal];volar=unit(sub(volar,[dot(volar,direction)*v for v in direction]));transverse=unit(cross(direction,volar));flex=[];spread=[]
    for sample in poses:
     q=sample['local49'][name]['quaternion'];v=rotate(q,direction);flex.append(math.degrees(math.atan2(dot(v,volar),dot(v,direction))));spread.append(math.degrees(math.atan2(dot(v,transverse),dot(v,direction))))
    joints[str(j)]={'flexDegrees':{'min':min(flex),'max':max(flex),'mean':sum(flex[:-1])/240},'spreadDegrees':{'min':min(spread),'max':max(spread),'mean':sum(spread[:-1])/240}}
   fingers[digit]=joints
  results[side]={'anatomicalDorsalNormalNative':normal,'fingers':fingers}
  e=[]
  for sample in poses:
   q=sample['local49']['foreArm'+side]['quaternion'];w,x,y,z=q;e.append([math.degrees(math.atan2(2*(w*x+y*z),1-2*(x*x+y*y))),math.degrees(math.asin(max(-1,min(1,2*(w*y-z*x))))),math.degrees(math.atan2(2*(w*z+x*y),1-2*(y*y+z*z)))])
  elbows[side]={'nativeLocalEulerXYZDegrees':{axis:{'min':min(x[i] for x in e),'max':max(x[i] for x in e)} for i,axis in enumerate(['X','Y','Z'])},'interpretation':'Native+Zup anatomical rest uses forearm mostly−Z; Euler values are diagnostic, not authority.'}
 report['versions'][version]={'sourceControlsSHA256':hashlib.sha256((P/version/'jog-controls.json').read_bytes()).hexdigest(),'hands':results,'elbows':elbows}
a=json.loads((P/'v2/jog-controls.json').read_text());b=json.loads((P/'v3/jog-controls.json').read_text());fields=['pelvisLocalPositionMetres','pelvisQuaternion','kneePoleRootSpace','footConstraintErrorMetres'];report['unchangedContactInputsAndBodyChannels']={k:all(x[k]==y[k] for x,y in zip(a['samples'],b['samples'])) for k in fields}
pa=json.loads((P/'v2/native-jog-local-poses.json').read_text())['samples'];pb=json.loads((P/'v3/native-jog-local-poses.json').read_text())['samples'];protected=['hips','spine','chest','neck','head','upperLegL','lowerLegL','footL','toeL','upperLegR','lowerLegR','footR','toeR'];report['protectedNativeChannelsExact']={n:all(x['local49'][n]==y['local49'][n] for x,y in zip(pa,pb)) for n in protected}
assert all(report['unchangedContactInputsAndBodyChannels'].values()) and all(report['protectedNativeChannelsExact'].values())
(P/'v3/hand-retarget-measurement.json').write_text(json.dumps(report,indent=2)+'\n')
for version in ['v2','v3']:
 print(version,'index2',report['versions'][version]['hands']['L']['fingers']['index']['2'],'elbowL',report['versions'][version]['elbows']['L'])
print('All protected torso/legs/contact controls EXACT')
