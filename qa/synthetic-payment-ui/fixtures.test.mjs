import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureReply, ROOM_PATH, ORDER_ID } from './fixtures.mjs';
const get=(path,role='member',method='GET')=>fixtureReply(role,method,new URL(path,'http://127.0.0.1:4173'));
test('denies unknown API, odd query variants and all writes rather than returning generic fixtures',()=>{
  for(const route of ['/api','/api/v2/auth/me','/api/v1/unrecognized','/api/v1/auth/me?t=other','/api/v1/withdrawals/quote','/api/v1/auth/login','/sg/callback','/graphql','/payments/post','/assets/%2funsafe.js'])
    assert.equal(get(route).type,'deny');
  for(const path of ['/api/v1/agent-orders','/api/v1/withdrawals/quote','/api/v1/auth/login','/api/v1/payment-orders/deposit/'+ORDER_ID+'/messages','/payment-requirements'])
    assert.equal(get(path,'member','POST').type,'deny');
  assert.equal(get('/api/v1/member-rewards/activity','member','POST').type,'known-block');
  assert.equal(get('/api/v1/member-rewards/activity?bad=1','member','POST').type,'deny');
});
test('role and amount allowlists and static scope are exact',()=>{
  assert.equal(get('/api/v1/wallet/exchange-rate').type,'deny');
  assert.equal(get('/api/v1/wallet/exchange-rate','admin').body.data.cryptoDepositMinUsdCents,1000);
  assert.equal(get('/api/v1/workspaces/access').body.data.admin,false);
  assert.equal(get('/api/v1/workspaces/access','admin').body.data.admin,true);
  assert.equal(get('/api/v1/agent-config/countries/synthetic-etb/deposit-preview?fiatAmount=9999').type,'deny');
  assert.equal(get('/api/v1/agent-config/countries/synthetic-etb/deposit-preview?fiatAmount=10000').body.data.preview.coinAmount,10000);
  assert.equal(get('/api/v1/payment-orders/deposit/'+ORDER_ID).body.data.fiatAmount,'9245');
  for(const path of ['/payment-requirements','/wallet/deposit',ROOM_PATH,'/assets/entry.js'])assert.equal(get(path).type,'static');
});
