import {useState} from 'react';
import {useAuth} from '@/providers/auth-provider';
import {useWalletAction} from '@/hooks/use-wallet-action';
import {inputToMinor} from '@/lib/payment-money';

type Role = 'main-admin' | 'manager';
type Target = {id:string; label:string};
/** Mount from a staff page with server-scoped targets. UI visibility is not authorization. */
export function DepositFundingForm({role,targets}:{role:Role;targets:readonly Target[]}) {
  const {user} = useAuth();
  return user ? <FundingForm key={user.id+':'+role} role={role} targets={targets}/> : null;
}
function FundingForm({role,targets}:{role:Role;targets:readonly Target[]}) {
  const [id, setId]=useState('');
  const [amount,setAmount]=useState('');
  const [reference,setReference]=useState('');
  const [confirm,setConfirm]=useState(false);
  const action=useWalletAction('deposit-funding');
  const minor=inputToMinor(amount,2);
  const admin=role==='main-admin';
  const path=admin ? '/staff/deposit-funding/receipts' : '/staff/deposit-funding/allocations';
  const ready=!action.blocked && minor!==null && targets.some(t=>t.id===id) && (!admin || reference.trim().length>=4);
  return <section aria-label="P2P deposit funding">
    <h2>{admin ? 'Record funds received' : 'Allocate funds to an Agent'}</h2>
    <p>{admin ? 'Record only money you have already received.' : 'This uses your available deposit funds. It does not send money to a member.'}</p>
    <fieldset disabled={action.blocked}>
      <label>{admin ? 'Manager' : 'Agent'} <select value={id} onChange={e=>{setId(e.target.value);setConfirm(false);}}>
        <option value="">Choose…</option>
        {targets.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
      </select></label>
      <label>Amount in ETB <input inputMode="decimal" value={amount} onChange={e=>{setAmount(e.target.value);setConfirm(false);}}/></label>
      {admin && <label>Receipt reference <input value={reference} maxLength={128} onChange={e=>{setReference(e.target.value);setConfirm(false);}}/></label>}
      <label><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/> Confirm these details</label>
      <button type="button" disabled={!ready || !confirm} onClick={async ()=>{
        if(!ready || !confirm || minor===null) return;
        setConfirm(false);
        if(await action.run(path, admin ? {managerId:id,amountMinor:String(minor),receiptReference:reference.trim()} : {agentId:id,amountMinor:String(minor)})){
          setAmount('');setReference('');
        }
      }}>{admin ? 'Record receipt' : 'Allocate funds'}</button>
    </fieldset>
    {action.pending && <button type="button" disabled={action.busy} onClick={async ()=>{
      if(!action.pending)return;
      if(await action.run(action.pending.path,action.pending.body)){setAmount('');setReference('');}
    }}>Retry saved request</button>}
    {action.message && <p role="status">{action.message}</p>}
  </section>;
}
