"""Metadata-safe native append-resource cleanup, never a runtime-leak claim."""
import bpy,hashlib,json
from pathlib import Path

def deduplicate_native_images(authored=True):
 seen={};removed=[];before=len(bpy.data.images)
 for im in sorted(list(bpy.data.images),key=lambda x:(x.name.count('.'),len(x.name),x.name)):
  if not im.packed_file:continue
  raw=bytes(im.packed_file.data);digest=hashlib.sha256(raw).hexdigest();key=(digest,im.source,tuple(im.size),im.channels,im.colorspace_settings.name,im.alpha_mode,im.is_float,im.file_format)
  if key not in seen:seen[key]=im;continue
  original=seen[key];name=im.name;im.user_remap(original);im.use_fake_user=False
  assert im.users==0,(name,'stillowned',im.users)
  removed.append({'duplicate':name,'canonical':original.name,'packedSHA256':digest,'bytes':len(raw),'source':im.source,'colorSpace':im.colorspace_settings.name,'alphaMode':im.alpha_mode,'dimensions':list(im.size)})
  bpy.data.images.remove(im)
 if authored:
  jersey=bpy.data.objects['niko-jersey'];bad=[]
  for v in jersey.data.vertices:
   for g in v.groups:
    if jersey.vertex_groups[g.group].name in ['neck','head'] and g.weight>1e-7:bad.append(v.index)
  assert not bad,bad[:12]
  bpy.context.scene['R11_JerseyForbiddenBones']=json.dumps(['neck','head']);bpy.context.scene['R11_AllShirtVerticesReauthored']=True
 return {'status':'Native-only append duplicates removed by exactpackedbytes+completeimage metadata; uniqueimages/editable source maps and vertexcoloraliases unchanged','beforeImageBlocks':before,'afterImageBlocks':len(bpy.data.images),'removed':removed,'removedPackedBytes':sum(x['bytes'] for x in removed),'runtimeTextureCounterClaim':False}
if __name__=='__main__':
 p=Path(bpy.data.filepath);r=deduplicate_native_images();bpy.ops.wm.save_as_mainfile(filepath=str(p),compress=True);r['blendSHA256']=hashlib.sha256(p.read_bytes()).hexdigest();r['blendBytes']=p.stat().st_size;(p.parent/'validation/image-deduplication.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
