// Service-control-flow tests only. Persistence/locking/SQL are intentionally mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  transaction: vi.fn(), order: vi.fn(), agent: vi.fn(), country: vi.fn(), account: vi.fn(),
  rate: vi.fn(), lockedRate: vi.fn(), create: vi.fn(), query: vi.fn(), quote: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: {
  $transaction: m.transaction, agentOrder: {findUnique:m.order}, agent:{findUnique:m.agent},
  country:{findUnique:m.country}, agentPaymentAccount:{findUnique:m.account},
  withdrawalQuote:{findUnique:m.quote},
} }));
vi.mock('./usd-config-service.js', () => ({selectPaymentRate:m.rate}));
vi.mock('../middleware/index.js', async () => await import('../middleware/api-error.js'));
vi.mock('./order-lifecycle.js', () => ({lockDepositReceivingAccount:vi.fn(),depositEntryDeadline:vi.fn(),depositClock:vi.fn(),assertDepositReady:vi.fn()}));
vi.mock('./agent-service.js', () => ({assertPlatformAdmin:vi.fn()}));
vi.mock('./held-deposit-recovery-service.js', () => ({heldAdmissionState:vi.fn()}));
vi.mock('../economy/coin-ledger-service.js', () => ({creditCoins:vi.fn(),lockUserEconomicScope:vi.fn()}));
vi.mock('./inventory-service.js', () => ({reserveInventory:vi.fn(),releaseReservedInventory:vi.fn(),consumeReservedInventory:vi.fn()}));
import { createWithdrawalQuote, getOwnWithdrawalQuote } from '../withdrawals/quote-service.js';
import { createAgentOrder } from './order-service.js';
const args = {agentId:'agent',countryId:'country',paymentAccountId:'account',fiatAmount:10000,idempotencyKey:'synthetic-request'};
const country={id:'country',currencyCode:'ETB',isActive:true,agentPaymentEnabled:true};
let rate:any;
beforeEach(() => {
  vi.resetAllMocks();
  rate={id:'rate',isActive:true,coinsPerUnit:100,pricingPolicy:{version:'ETB_V1',walletCurrency:'ETB',minorDigits:2,localPerUsd:'150',source:'Synthetic only',observedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),p2pDepositMinUsdCents:200,p2pWithdrawalAboveUsdCents:400,cryptoDepositMinUsdCents:1000,cryptoWithdrawalAboveUsdCents:2000,feeMinor:0}};
  m.rate.mockResolvedValue(rate);m.lockedRate.mockImplementation(async()=>rate);
  m.country.mockResolvedValue(country);m.order.mockResolvedValue(null);
  m.agent.mockResolvedValue({id:'agent',userId:'other',status:'ACTIVE',countryId:'country'});
  m.account.mockResolvedValue({agentId:'agent',countryId:'country',status:'APPROVED',safetyHold:false,methodDef:{isActive:true,countryId:'country'}});
  m.create.mockImplementation(async({data})=>({id:'synthetic-quote',...data}));
  m.transaction.mockImplementation(async(fn)=>fn({$queryRaw:m.query,country:{findUnique:m.country},exchangeRateConfig:{findUniqueOrThrow:m.lockedRate},withdrawalQuote:{create:m.create}}));
});
describe('mocked ETB service boundaries (no database)',()=>{
  it('rejects 499.99 withdrawal without a persisted quote',async()=>{
    await expect(createWithdrawalQuote('member',{countryId:'country',coinAmount:49999})).rejects.toThrow('Minimum P2P withdrawal is 500 ETB');expect(m.create).not.toHaveBeenCalled();
  });
  it('passes inclusive 500 withdrawal to persistence with server-owned identity and pinned policy',async()=>{
    const q=await createWithdrawalQuote('member',{countryId:'country',coinAmount:50000});
    expect(q).toMatchObject({userId:'member',coinAmount:50000,fiatAmount:50000n,status:'ACTIVE',pricingSnapshot:{p2pMinimumPolicy:{withdrawalMinMinor:50000}}});
    expect(q.expiresAt.getTime()).toBeLessThanOrEqual(Date.parse(rate.pricingPolicy.expiresAt));
  });
  it.each(['paused','disabled-rate','expired-rate'])('retains %s gate at exact minimum',async gate=>{
    if(gate==='paused')m.country.mockResolvedValue({...country,agentPaymentEnabled:false});
    if(gate==='disabled-rate')rate.isActive=false;
    if(gate==='expired-rate')rate.pricingPolicy.expiresAt=new Date(Date.now()-1).toISOString();
    await expect(createWithdrawalQuote('member',{countryId:'country',coinAmount:50000})).rejects.toThrow();expect(m.create).not.toHaveBeenCalled();
  });
  it('rejects malformed and overflow withdrawals before any transaction',async()=>{
    for(const coinAmount of [NaN,Infinity,1.5,0,-1,1000000001])await expect(createWithdrawalQuote('member',{countryId:'country',coinAmount})).rejects.toThrow();
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it('enforces quote ownership',async()=>{m.quote.mockResolvedValue({userId:'other'});await expect(getOwnWithdrawalQuote('member','quote')).rejects.toThrow('does not belong');});
  it('preserves successful legacy deposit replay before current pricing',async()=>{
    const old={...args,fiatAmount:5000,id:'old',pricingSnapshot:{version:'ETB_V1'}};m.order.mockResolvedValue(old);
    await expect(createAgentOrder('member',{...args,fiatAmount:5000})).resolves.toEqual({order:old,idempotent:true});expect(m.rate).not.toHaveBeenCalled();expect(m.transaction).not.toHaveBeenCalled();
  });
  it('rejects altered legacy replay',async()=>{m.order.mockResolvedValue({...args,fiatAmount:5000});await expect(createAgentOrder('member',args)).rejects.toThrow('different request data');expect(m.transaction).not.toHaveBeenCalled();});
  it('rejects 99.99 deposit before reservation transaction',async()=>{await expect(createAgentOrder('member',{...args,fiatAmount:9999})).rejects.toThrow('Minimum P2P deposit is 100 ETB');expect(m.transaction).not.toHaveBeenCalled();});
  it('passes 100 deposit pricing to transaction boundary, not a persistence proof',async()=>{m.transaction.mockRejectedValue(new Error('SYNTHETIC_TRANSACTION_BOUNDARY'));await expect(createAgentOrder('member',args)).rejects.toThrow('SYNTHETIC_TRANSACTION_BOUNDARY');expect(m.transaction).toHaveBeenCalledTimes(1);});
  it('retains stricter agent minimum',async()=>{m.agent.mockResolvedValue({id:'agent',userId:'other',status:'ACTIVE',countryId:'country',minOrderAmount:20000});await expect(createAgentOrder('member',args)).rejects.toThrow("agent's minimum");expect(m.transaction).not.toHaveBeenCalled();});
  it('retains receiving-account safety hold',async()=>{m.account.mockResolvedValue({agentId:'agent',status:'APPROVED',safetyHold:true});await expect(createAgentOrder('member',args)).rejects.toThrow('not currently approved');expect(m.transaction).not.toHaveBeenCalled();});
});
