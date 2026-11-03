"""Encode untouched native frame pairs with a separate annotation strip."""
import argparse,json,hashlib,shutil,subprocess
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
ap=argparse.ArgumentParser();ap.add_argument('--before',type=Path,required=True);ap.add_argument('--after',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);ap.add_argument('--status',default='Native candidate; visual acceptance and runtime adoption held');args=ap.parse_args();args.out.mkdir(parents=True,exist_ok=True)
before=json.loads((args.before/'capture-ledger-before.json').read_text());after=json.loads((args.after/'capture-ledger-after.json').read_text());assert before['samplesPerCycle']==after['samplesPerCycle'];n=before['samplesPerCycle'];fps=n*before['cadence'];assert before['lighting']==after['lighting'];assert before['render']==after['render'];by={(r['view'],round(r['phase'],9)):r for r in before['frames']};ay={(r['view'],round(r['phase'],9)):r for r in after['frames']};assert by.keys()==ay.keys()
for key,old in by.items():
 new=ay[key]
 for field in ['cameraPosition','cameraTarget','cameraRotation','rootReferenceMetres']:
  assert max(abs(a-b) for a,b in zip(old[field],new[field]))<1e-7,(key,field)
 for row,directory in [(old,args.before),(new,args.after)]:assert hashlib.sha256((directory/row['file']).read_bytes()).hexdigest()==row['sha256']
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',12);width=before['render']['width']*2;caption_height=80;records=[];ff=shutil.which('ffmpeg');fp=shutil.which('ffprobe');assert ff and fp
for view in ['front','side']:
 for slow in [False,True]:
  label=view+('-slow' if slow else '-normal');out=args.out/(label+'.mp4');rate=fps/4 if slow else fps;repeat=0 if slow else 3;frames=n if slow else n*4
  lines=[args.status,'NATIVE BLENDER CPU AUTHORING / NOT MATCH OR DEVICE VALIDATION','BEFORE: retained geometry / baseline motion | AFTER: fitted geometry / supported retarget',('0.25x playback, one native cycle' if slow else 'Normal reference timing, one native cycle repeated x4')+f' | encoded {rate:.3f} fps, not runtime FPS']
  panel=args.out/(label+'-annotation.png');im=Image.new('RGB',(width,caption_height),(15,15,18));ImageDraw.Draw(im).multiline_text((8,5),'\n'.join(lines),font=font,fill='white',spacing=4);im.save(panel)
  filtering=f'[0:v][1:v]hstack=inputs=2[players];[players][2:v]vstack=inputs=2:shortest=1,loop=loop={repeat}:size={n}:start=0,setpts=N/({rate}*TB)[out]'
  cmd=[ff,'-n','-hide_banner','-loglevel','warning','-framerate',str(rate),'-i',str(args.before/(view+'-before-%04d.png')),'-framerate',str(rate),'-i',str(args.after/(view+'-after-%04d.png')),'-loop','1','-framerate',str(rate),'-i',str(panel),'-filter_complex',filtering,'-map','[out]','-frames:v',str(frames),'-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',str(out)]
  with (args.out/(label+'-encode.log')).open('w') as log:subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT,check=True)
  probe=json.loads(subprocess.check_output([fp,'-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,avg_frame_rate,nb_frames,duration','-of','json',str(out)]))['streams'][0];assert int(probe['nb_frames'])==frames
  records.append({'file':out.name,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'sourceNativeFrames':n,'sourceCycleSeconds':before['cycleSeconds'],'repeatCycles':1 if slow else 4,'playbackScale':.25 if slow else 1,'probe':probe,'sourceBeforeBlendSHA256':before['sourceBlendSHA256'],'sourceAfterBlendSHA256':after['sourceBlendSHA256']})
(args.out/'encoded-cycle-report.json').write_text(json.dumps({'reviewStatus':args.status,'scope':'Matched native before/after only; both share preserved accepted boot-flex reference. Distinct geometry and motion together; source camera/light/phase/root paired. Annotation strip is separate from untouched source pixels. Encoded rate is playback, not measured runtime FPS; physical/live checks pending.','sourceBeforeLedger':str(args.before/'capture-ledger-before.json'),'sourceAfterLedger':str(args.after/'capture-ledger-after.json'),'clips':records},indent=2)+'\n');print(json.dumps(records,indent=2))
