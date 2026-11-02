import argparse,json,math
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--workdir',type=Path,default=Path(__file__).resolve().parent);a=ap.parse_args();p=a.workdir;d=json.loads((p/'native-jog-local-poses.json').read_text());root=Path(__file__).resolve().parent;rest=json.loads((root.parent/'verified-source/reference-clip-contact-manifest.json').read_text())['rig']['restBones'];names=['hips','spine','chest','neck','head'];values={n:[] for n in names}
def mul(a,b):
 w,x,y,z=a;v,s,t,u=b;return [w*v-x*s-y*t-z*u,w*s+x*v+y*u-z*t,w*t-x*u+y*v+z*s,w*u+x*t-y*s+z*v]
for sample in d['samples']:
 g={}
 for n,b in sample['local49'].items():
  par=rest[n]['parent'];g[n]=mul(g[par],b['quaternion']) if par else b['quaternion']
  if n in values:
   norm=math.sqrt(sum(v*v for v in g[n]));w,x,y,z=[v/norm for v in g[n]]
   shoulder=math.asin(max(-1,min(1,2*(x*z-w*y))));yaw=math.atan2(2*(w*z-x*y),1-2*(x*x+z*z));pitch=math.atan2(2*(w*x-y*z),1-2*(x*x+y*y))
   values[n].append({'phase':sample['phase'],'anatomicalLateralRollDegrees':math.degrees(shoulder),'projectedForwardYawDegrees':math.degrees(yaw),'uprightPitchDiagnosticDegrees':math.degrees(pitch)})
report={'scope':'Read-only native49 anatomical orientation measurement. Roll=asin((Q*restLeftAxis).Z); yaw=heading of projected Q*forward; joint rest unchanged','bones':{}}
for n,rows in values.items():report['bones'][n]={k:{'min':min(r[k] for r in rows),'max':max(r[k] for r in rows),'phase0':rows[0][k]} for k in ['anatomicalLateralRollDegrees','projectedForwardYawDegrees','uprightPitchDiagnosticDegrees']}
(p/'torso-ranges.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
