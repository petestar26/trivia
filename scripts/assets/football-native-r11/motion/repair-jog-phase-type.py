"""Repair native authoring-control type only. Does not alter joint/contact keys."""
import bpy,json,math

def repair_jog_phase_property(rig=None):
 rig=rig or bpy.data.objects['Production49'];old_type=type(rig.get('JogPhase')).__name__
 if 'JogPhase' in rig:del rig['JogPhase']
 rig['JogPhase']=0.0
 rig.id_properties_ui('JogPhase').update(min=0.0,max=1.0,soft_min=0.0,soft_max=1.0,precision=6)
 changed=[]
 for action in bpy.data.actions:
  if action.name not in ['NIKO_JOG_SUPPORTED_V1','BASELINE_CURRENT_JOG_2p4']:continue
  for curve in action.fcurves:
   if curve.data_path=='["JogPhase"]':
    curve.update_autoflags(rig);changed.append(action.name)
 for action in bpy.data.actions:
  if action.name=='REFERENCE_JOG_LINEAR_ROOT_NOT_RUNTIME':
   for curve in action.fcurves:curve.extrapolation='LINEAR'
 rig.update_tag();bpy.context.view_layer.update()
 # Test actual evaluated IDproperty, not merely FCurve's raw float keys.
 saved_action=rig.animation_data.action if rig.animation_data else None;frame=bpy.context.scene.frame_current;subframe=bpy.context.scene.frame_subframe;cadence=1.654;rows=[]
 for name in changed:
  rig.animation_data.action=bpy.data.actions[name]
  for phase in [0,.125,.25,.375,.5,.625,.75,.875]:
   f=1+phase*30/cadence;bpy.context.scene.frame_set(math.floor(f),subframe=f%1);bpy.context.view_layer.update();value=rig['JogPhase'];assert isinstance(value,float);assert abs(value-phase)<2e-6,(name,phase,value);rows.append({'action':name,'phase':phase,'evaluatedJogPhase':value})
 rig.animation_data.action=saved_action;bpy.context.scene.frame_set(frame,subframe=subframe);bpy.context.view_layer.update()
 return {'oldType':old_type,'newType':type(rig['JogPhase']).__name__,'phaseActions':changed,'samples':rows,'scope':'Native phase metadata/flags repair only; body/root/foot/contact curve values unchanged'}
if __name__=='__main__':print(json.dumps(repair_jog_phase_property()))
