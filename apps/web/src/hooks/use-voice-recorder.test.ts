import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useVoiceRecorder} from './use-voice-recorder';
let track:ReturnType<typeof vi.fn>;let getUserMedia:ReturnType<typeof vi.fn>;
class Recorder {
 static isTypeSupported(){return true;}
 state='inactive';mimeType='audio/ogg;codecs=opus';ondataavailable:any;onstop:any;onerror:any;
 start(){this.state='recording';}
 stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['audio'])});this.onstop?.();});}
}
beforeEach(()=>{vi.useFakeTimers();track=vi.fn();getUserMedia=vi.fn().mockResolvedValue({getTracks:()=>[{stop:track}]});vi.stubGlobal('MediaRecorder',Recorder);Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia}});});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();delete (navigator as any).mediaDevices;});
it('retains a five-minute automatic stop as an unsent draft',async()=>{
 const complete=vi.fn();const {result}=renderHook(()=>useVoiceRecorder(complete));await act(async()=>{await result.current.start();});
 await act(async()=>{await vi.advanceTimersByTimeAsync(300000);});expect(result.current.isRecording).toBe(false);expect(complete).toHaveBeenCalledTimes(1);expect(complete.mock.calls[0][0].size).toBeGreaterThan(0);expect(complete.mock.calls[0][1]).toBe(300000);expect(track).toHaveBeenCalled();
});
it('delivers a manual stop once and keeps its true duration',async()=>{
 const complete=vi.fn();const {result}=renderHook(()=>useVoiceRecorder(complete));await act(async()=>{await result.current.start();});await act(async()=>{await vi.advanceTimersByTimeAsync(1750);await result.current.stop();});
 expect(complete).toHaveBeenCalledTimes(1);expect(complete.mock.calls[0][1]).toBe(1750);expect(result.current.elapsedMs).toBe(1750);
});
it('releases permission granted after leaving the group and cannot start two requests',async()=>{
 let grant!:(stream:any)=>void;getUserMedia.mockImplementation(()=>new Promise(resolve=>{grant=resolve;}));const complete=vi.fn();const {result,unmount}=renderHook(()=>useVoiceRecorder(complete));
 let start!:Promise<void>;act(()=>{start=result.current.start();void result.current.start();});expect(getUserMedia).toHaveBeenCalledTimes(1);unmount();await act(async()=>{grant({getTracks:()=>[{stop:track}]});await start;});expect(track).toHaveBeenCalledTimes(1);expect(complete).not.toHaveBeenCalled();
});
it('cancel stops the microphone and discards the draft',async()=>{
 const complete=vi.fn();const {result}=renderHook(()=>useVoiceRecorder(complete));await act(async()=>{await result.current.start();});await act(async()=>{result.current.cancel();});expect(result.current.isRecording).toBe(false);expect(track).toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
});