const games = [
  ['sky_crash', 'Sky Crash', true],
  ['crash_point', 'Crash Point', true],
  ['dice', 'Dice', true],
  ['spin_win', 'Lucky Spin', true],
  ['turbo_keno', 'Turbo Keno', true],
  ['trivia', 'Trivia', true],
  ['number_challenge', 'Number Challenge', false],
  ['thunder_derby_3d', 'Thunder Derby', true],
  ['virtual_football_3d', 'Virtual Football', true],
  ['neon_hounds_3d', 'Neon Hounds', false],
  ['turbo_circuit_3d', 'Turbo Circuit', false],
  ['starfall_nebula', 'Starfall Nebula', false],
].map(([key, name, ready]) => ({ id: key, key, name, practiceAvailable: ready,
  catalogStatus: key === 'trivia' ? 'AVAILABLE' : 'COMING_SOON', isActive: key === 'trivia',
  mode: key === 'trivia' ? 'BONUS' : 'WAGER', type: key, family: 'INSTANT',
  wagerCurrency: 'COINS', rewardCurrency: 'COINS', minBet: 0, maxBet: 0, currentRulesVersion: null }));
const auth = `export const useAuth = () => ({ user: { id: 'local-ui-fixture', username: 'Member', displayName: 'Member', role: 'USER' }, logout: async () => {} });`;
const api = `const games=${JSON.stringify(games)};
  export const unwrapData = (response) => response.data;
  export const api = {
    get: async (path) => ({ success:true, data: path === '/games' ? games : path.endsWith('/leaderboard') ? { period:'24h', tickets:Array.from({length:12}, (_, i) => ({ player:'Player sample' + String(i+1).padStart(4,'0'), roundId:'synthetic-round-' + (i+1), stake:100, paidCents: 1800-i*100, payout:1800-i*100 })) } : { coinsBalance:1250, gamePointsBalance:350 } }),
    listGroups: async () => ({ success:true, data:[
      { id:'night-owls',name:'Night Owls',description:'A little competition. A lot of good company.',memberCount:12,isMember:true,isPrivate:false,status:'ACTIVE' },
      { id:'weekend-club',name:'The Weekend Club',description:'Find your next game together.',memberCount:8,isMember:false,isPrivate:false,status:'ACTIVE' }
    ] })
  };`;
