/** Bounds even transports that fail to reject when aborted. */
export async function boundedRequest<T>(run:(signal:AbortSignal)=>Promise<T>,parent?:AbortSignal,milliseconds=8000):Promise<T> {
  const controller=new AbortController();
  let rejectAbort:(reason:unknown)=>void=()=>{};
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const abort=()=>{controller.abort();rejectAbort(new Error('Request not confirmed. Reconnecting to the server.'));};
  parent?.addEventListener('abort',abort,{once:true});
  if(parent?.aborted)abort();
  const timer=setTimeout(abort,milliseconds);
  try{return await Promise.race([run(controller.signal),aborted]);}
  finally{clearTimeout(timer);parent?.removeEventListener('abort',abort);}
}
