"""Merged native copy only: context scalar guards, no joint/root/phase keys changed."""
import bpy,json,hashlib

def protected_curve_hash(action):
 data=[]
 for f in action.fcurves:
  if f.data_path=='["JogContextEnabled"]':continue
  data.append({'path':f.data_path,'index':f.array_index,'extrapolation':f.extrapolation,'keys':[{'co':list(k.co),'left':list(k.handle_left),'right':list(k.handle_right),'interpolation':k.interpolation,'leftType':k.handle_left_type,'rightType':k.handle_right_type} for k in f.keyframe_points],'modifiers':[{'type':m.type,'modeBefore':getattr(m,'mode_before',None),'modeAfter':getattr(m,'mode_after',None)} for m in f.modifiers]})
 return hashlib.sha256(json.dumps(sorted(data,key=lambda x:(x['path'],x['index'])),sort_keys=True,separators=(',',':')).encode()).hexdigest()

def apply_jog_context_guards(rig=None):
 rig=rig or bpy.data.objects['Production49'];legacy=sorted([a for a in bpy.data.actions if a.name.startswith('REFERENCE_runtime_')],key=lambda a:a.name);supported=[bpy.data.actions[n] for n in ['BASELINE_CURRENT_JOG_2p4','NIKO_JOG_SUPPORTED_V1']]
 assert len(legacy)==13,('Expected explicit13Production49references',len(legacy))
 report=[]
 for action,value in [(a,0) for a in legacy]+[(a,1) for a in supported]:
  before=protected_curve_hash(action);curve=next((f for f in action.fcurves if f.data_path=='["JogContextEnabled"]'),None)
  if curve is None:curve=action.fcurves.new(data_path='["JogContextEnabled"]',index=0,action_group='NATIVE_SUPPORTED_JOG_CONTEXT')
  first,last=map(float,action.frame_range);frames=[first,last] if last>first else [first]
  curve.keyframe_points.clear();curve.keyframe_points.add(len(frames));curve.keyframe_points.foreach_set('co',[v for frame in frames for v in (frame,float(value))])
  for key in curve.keyframe_points:key.interpolation='CONSTANT'
  curve.extrapolation='CONSTANT';curve.update_autoflags(rig);action.update_tag();after=protected_curve_hash(action);assert before==after,(action.name,'Protected curve changed')
  action['PlayQubeSupportedJogContext']=value;report.append({'action':action.name,'nativeContextValue':value,'protectedJointRootPhaseCurvesBefore':before,'protectedJointRootPhaseCurvesAfter':after,'unchanged':True})
 sc=bpy.context.scene;sc['PlayQubeGuardedJogContextActions']=json.dumps([a.name for a in legacy]);sc['PlayQubeSupportedJogContextActions']=json.dumps([a.name for a in supported]);sc['PlayQubeJogContextGuardReport']=json.dumps(report);sc['PlayQubeJogContextScope']='Native source-reference corrective gate only; no application flag, root/ball/contact or official clock change'
 rig.update_tag();bpy.context.view_layer.update()
 return {'legacyActions':len(legacy),'supportedActions':len(supported),'actions':report,'scope':'Only native JogContextEnabled scalar guard channels changed; all other joint/root/phase curve data cryptographically unchanged'}
if __name__=='__main__':print(json.dumps(apply_jog_context_guards()))
