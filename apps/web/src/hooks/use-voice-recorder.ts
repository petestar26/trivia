import {useCallback,useEffect,useRef,useState} from 'react';
const MAX_DURATION_MS=300000;
const PREFERRED_MIME_TYPE='audio/ogg;codecs=opus';
export interface UseVoiceRecorderResult {
 isRecording:boolean;isStarting:boolean;isSupported:boolean;isUploading:boolean;elapsedMs:number;error:string|null;
 start:()=>Promise<void>;stop:()=>Promise<Blob|null>;cancel:()=>void;mimeType:string;
}
/** A completed recording is a draft; this hook never uploads or sends it. */
export function useVoiceRecorder(onComplete?:(blob:Blob,durationMs:number)=>void):UseVoiceRecorderResult {
 const [isRecording,setRecording]=useState(false),[isStarting,setStarting]=useState(false),[isSupported,setSupported]=useState(true);
 const [elapsedMs,setElapsed]=useState(0),[error,setError]=useState<string|null>(null),[mimeType,setMimeType]=useState(PREFERRED_MIME_TYPE);
 const recorderRef=useRef<MediaRecorder|null>(null),streamRef=useRef<MediaStream|null>(null),timerRef=useRef<number|null>(null);
 const startTime=useRef(0),generation=useRef(0),pending=useRef(false),alive=useRef(true),complete=useRef(onComplete);
 complete.current=onComplete;
 const stopTracks=(stream:MediaStream|null)=>stream?.getTracks().forEach(track=>track.stop());
 const clearTimer=useCallback(()=>{if(timerRef.current!==null){window.clearInterval(timerRef.current);timerRef.current=null;}},[]);
 const cancel=useCallback(()=>{
  generation.current++;pending.current=false;clearTimer();
  const recorder=recorderRef.current;recorderRef.current=null;
  if(recorder&&recorder.state!=='inactive')recorder.stop();
  stopTracks(streamRef.current);streamRef.current=null;
  if(alive.current){setStarting(false);setRecording(false);setElapsed(0);}
 },[clearTimer]);
 useEffect(()=>{
  alive.current=true;
  setSupported(!!window.MediaRecorder&&!!navigator.mediaDevices?.getUserMedia);
  return()=>{alive.current=false;cancel();};
 },[cancel]);
 const stop=useCallback(async():Promise<Blob|null>=>{
  const recorder=recorderRef.current;if(!recorder||recorder.state==='inactive')return null;
  recorderRef.current=null;clearTimer();
  const elapsed=Math.min(MAX_DURATION_MS,Math.max(0,Date.now()-startTime.current));
  // onstop was installed at start, before a manual stop or the duration limit.
  const finished=(recorder as MediaRecorder&{finished:Promise<Blob|null>}).finished;
  if(alive.current)setElapsed(elapsed);
  recorder.stop();stopTracks(streamRef.current);streamRef.current=null;
  return finished;
 },[clearTimer]);
 const start=useCallback(async()=>{
  if(pending.current||recorderRef.current)return;
  setError(null);if(!isSupported){setError('Voice recording is not supported in this browser.');return;}
  pending.current=true;setStarting(true);const attempt=++generation.current;let stream:MediaStream|null=null;
  try{
   stream=await navigator.mediaDevices.getUserMedia({audio:true});
   if(!alive.current||generation.current!==attempt){stopTracks(stream);return;}
   streamRef.current=stream;
   const options=window.MediaRecorder.isTypeSupported(PREFERRED_MIME_TYPE)?{mimeType:PREFERRED_MIME_TYPE}:{};
   const recorder=new window.MediaRecorder(stream,options);const chunks:Blob[]=[];
   recorderRef.current=recorder;setMimeType(recorder.mimeType||'audio/webm');
   recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
   (recorder as MediaRecorder&{finished:Promise<Blob|null>}).finished=new Promise(resolve=>{
    recorder.onstop=()=>{
     if(!alive.current||generation.current!==attempt){resolve(null);return;}
     clearTimer();recorderRef.current=null;stopTracks(stream);streamRef.current=null;
     const duration=Math.min(MAX_DURATION_MS,Math.max(0,Date.now()-startTime.current));
     const blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'});
     setElapsed(duration);setRecording(false);if(blob.size)complete.current?.(blob,duration);resolve(blob.size?blob:null);
    };
   });
   recorder.onerror=()=>{if(alive.current&&generation.current===attempt){cancel();setError('Recording error occurred.');}};
   recorder.start(250);startTime.current=Date.now();setElapsed(0);setRecording(true);
   timerRef.current=window.setInterval(()=>{const elapsed=Date.now()-startTime.current;if(elapsed>=MAX_DURATION_MS)void stop();else setElapsed(elapsed);},250);
  }catch(err){
   stopTracks(stream);if(alive.current&&generation.current===attempt){streamRef.current=null;recorderRef.current=null;setError((err as Error)?.name==='NotAllowedError'?'Microphone access denied. Please allow microphone access to record.':'Could not access the microphone.');}
  }finally{if(alive.current&&generation.current===attempt){pending.current=false;setStarting(false);}}
 },[isSupported,cancel,clearTimer,stop]);
 return {isRecording,isStarting,isSupported,isUploading:false,elapsedMs,error,start,stop,cancel,mimeType};
}