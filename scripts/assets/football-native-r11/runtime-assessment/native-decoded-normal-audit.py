"""Read-only decoded geometric normals; opaque Blender custom-normal bytes are not aliases."""
import argparse,hashlib,json,math,sys
from pathlib import Path
import bpy
R=Path(__file__).resolve().parents[1];ap=argparse.ArgumentParser();ap.add_argument('--blend',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);o=ap.parse_args(sys.argv[sys.argv.index('--')+1:]);baseline=R/'verified-source/native/PlayQube_ReviewPlayer_Baseline.blend'
bpy.ops.wm.open_mainfile(filepath=str(baseline),load_ui=False,use_scripts=False);hair=bpy.data.objects['niko-hair'].data;reference=[tuple(n.vector) for n in hair.corner_normals];indices=[tuple(p.vertices) for p in hair.polygons]
bpy.ops.wm.open_mainfile(filepath=str(o.blend),load_ui=False,use_scripts=False);rows=[]
for name in ['niko-head','niko-hair','niko-brows','niko-body','niko-jersey','niko-shorts','niko-socks','niko-boots']:
 mesh=bpy.data.objects[name].data;vectors=[tuple(n.vector) for n in mesh.corner_normals];finite=all(math.isfinite(v) for n in vectors for v in n);unit=max((abs(math.sqrt(sum(v*v for v in n))-1) for n in vectors),default=0);rows.append({'mesh':name,'corners':len(vectors),'finite':finite,'maxUnitLengthError':unit,'pass':finite and unit<2e-6})
hair=bpy.data.objects['niko-hair'].data;actual=[tuple(n.vector) for n in hair.corner_normals];same_indices=indices==[tuple(p.vertices) for p in hair.polygons];error=max((max(abs(x-y) for x,y in zip(a,b)) for a,b in zip(reference,actual)),default=0);hair_pass=same_indices and len(reference)==len(actual) and error<1e-6
report={'status':'PASS' if all(r['pass'] for r in rows) and hair_pass else 'FAIL','scope':'Decoded geometric normals only; shader historical runtime_normal alias separately validated in full native validator. No source save.','input':str(o.blend),'inputSHA256':hashlib.sha256(o.blend.read_bytes()).hexdigest(),'baselineSHA256':hashlib.sha256(baseline.read_bytes()).hexdigest(),'validatorSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'meshes':rows,'unchangedHairDecodedNormalComparison':{'cornerIndexOrderUnchanged':same_indices,'sameCornerCount':len(reference)==len(actual),'maximumComponentDifference':error,'pass':hair_pass}}
o.out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if report['status']!='PASS':raise RuntimeError('Decoded geometric normal audit failed')
