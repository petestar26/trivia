export const ORDER_ID='11111111-1111-4111-8111-111111111111';
export const ROOM_PATH='/wallet/orders/deposit/'+ORDER_ID;
const base='/api/v1';
const country='synthetic-etb';
const account={id:'synthetic-payout',countryId:country,status:'ACTIVE',displayLabel:'Synthetic payout account',accountDetails:{}};
const exchange=()=>({available:true,version:'ETB_V1',localPerUsd:'150',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+10*60e3).toISOString(),p2pDepositMinUsdCents:200,p2pWithdrawalAboveUsdCents:400,cryptoDepositMinUsdCents:1000,cryptoWithdrawalAboveUsdCents:2000});
export function fixtureReply(role,method,u) {
  const p=u.pathname;
  const deny=label=>({type:'deny',label});
  const reply=(data,meta)=>({type:'fixture',body:{success:true,data,...(meta?{meta}:{})}});
  if(/^\/(ws|socket\.io)\/?$/.test(p) && method==='GET') return {type:'known-block',label:'loopback socket transport blocked'};
  if(p===base+'/member-rewards/activity'&&method==='POST'&&!u.search) return {type:'known-block',label:'automatic reward activity blocked; no response or mutation'};
  if(!['GET','HEAD'].includes(method))return deny('non-read request blocked');
  if(!p.startsWith('/api/')&&p!=='/api'){
    const documents=new Set(['/','/payment-requirements','/wallet/deposit','/wallet/withdraw',ROOM_PATH,'/admin/pricing']);
    const asset=/^\/(assets|icons|images|art|artwork|models)\/[a-zA-Z0-9_.@%/+~-]+$/.test(p)
      || /^\/(favicon\.(ico|svg)|apple-touch-icon\.png|manifest\.webmanifest|app-recovery\.js)$/.test(p);
    if(!u.search && (documents.has(p)||asset) && !p.split('/').some(x=>x==='.'||x==='..'||/%(?:2e|2f|5c)/i.test(x)))
      return {type:'static'};
    return deny('non-allowlisted static route blocked');
  }
  if(method!=='GET'||!p.startsWith(base+'/'))return deny('unrecognized API blocked');
  const route=p.slice(base.length);
  if(route==='/notifications'){
    const params=[...u.searchParams];
    if(params.some(([k,v])=>!['page','pageSize','limit','offset','unread'].includes(k)||!/^(\d{1,3}|true|false)$/.test(v)))return deny('invalid notification query');
    return reply([],{count:0,total:0,unreadCount:0,hasMore:false});
  }
  if(route==='/agent-config/countries/'+country+'/deposit-preview'){
    const entries=[...u.searchParams];
    if(entries.length===0)return reply({policy:exchange(),preview:null});
    if(entries.length===1&&entries[0][0]==='fiatAmount'&&entries[0][1]==='10000') return reply({policy:exchange(),preview:{coinAmount:10000}});
    return deny('unrecognized pricing query blocked');
  }
  if(u.search)return deny('unexpected query blocked');
  switch(route){
    case '/auth/me':return reply({user:{id:'synthetic-'+role,username:'fixture-'+role,displayName:'Synthetic '+role,role:role==='admin'?'ADMIN':'USER',status:'ACTIVE',isVerified:true}});
    case '/workspaces/access':return reply({role:role==='admin'?'ADMIN':'USER',admin:role==='admin',agent:false,agentStatus:null});
    case '/wallet':return reply({coinsBalance:100000,coinAvailability:{spendable:100000,betOnly:0}});
    case '/wallet/payment-options':return reply({countries:[{id:country,name:'Synthetic ETB',currencyCode:'ETB',usdPricingEnabled:true,agentPaymentEnabled:true}],agents:[{id:'synthetic-agent',countryId:country,displayName:'Synthetic approved agent',minOrderAmount:1,maxOrderAmount:1000000,paymentAccounts:[{id:'synthetic-method-account',methodDef:{name:'Synthetic bank transfer'}}]}],isAgent:false,isAdmin:role==='admin'});
    case '/agent-orders/me':
    case '/withdrawals/me':
    case '/agent-config/countries/synthetic-etb/payment-methods/active':return reply([]);
    case '/withdrawals/payout-accounts':return reply([account]);
    case '/wallet/exchange-rate':return role==='admin'?reply(exchange()):deny('member admin-reference request blocked');
    case '/payment-orders/deposit/'+ORDER_ID:{
      const now=new Date().toISOString();
      return reply({id:ORDER_ID,number:'AG-SYNTHETIC-0001',kind:'deposit',role:'member',status:'COMPLETED',coinAmount:9125,fiatAmount:'9245',fiatCurrency:'ETB',pricingSnapshot:{minorDigits:2,feeMinor:123},paymentSnapshot:{accountName:'Synthetic recipient',accountNumber:'SYNTHETIC-NOT-PAYABLE',bankName:'Synthetic bank'},createdAt:now,serverNow:now,deadline:null,confirmationDeadline:null,memberName:'Synthetic member',agentName:'Synthetic agent',hold:{status:'CONSUMED',amount:9125},submission:null,appeals:[],recovery:null,messages:[],nextCursor:null,actions:{markPaid:false,release:false,cancel:false,claim:false,submitPayout:false,confirmReceipt:false,appeal:false,latePayment:false,message:false}});
    }
    default:return deny('unexpected API GET blocked');
  }
}
