import { expect, it } from 'vitest';
import { pvpWinnerIds, validatePvpSelection } from './group-pvp.js';
it('awards exact Spin hits and stable ties, refunds a missed draw',()=>{
  const players=[{userId:'b',selection:[7]},{userId:'a',selection:[7]},{userId:'c',selection:[0]}];
  expect(pvpWinnerIds('spin_win',players,[7])).toEqual(['a','b']);
  expect(pvpWinnerIds('spin_win',players,[8])).toEqual([]);
  expect(pvpWinnerIds('spin_win',players,[0])).toEqual(['c']);
});
it('scores Keno by hits with equal five-number entries and refunds all-zero draws',()=>{
  const players=[{userId:'a',selection:[1,2,3,4,5]},{userId:'b',selection:[1,2,3,4,80]}];
  expect(pvpWinnerIds('turbo_keno',players,Array.from({length:20},(_,i)=>i+1))).toEqual(['a']);
  expect(pvpWinnerIds('turbo_keno',players,Array.from({length:20},(_,i)=>i+21))).toEqual([]);
});
it.each([[1,1,2,3,4],[1,2,3,4],[0,1,2,3,4],[1,2,3,4,81],[1,2,3,4,NaN]].map(selection=>({selection})))('rejects invalid Keno entry $selection',({selection})=>{
  expect(()=>validatePvpSelection('turbo_keno',selection)).toThrow();
});
it('rejects invalid outcomes before choosing winners',()=>{
  expect(()=>pvpWinnerIds('spin_win',[],[37])).toThrow();
  expect(()=>pvpWinnerIds('turbo_keno',[],Array(20).fill(1))).toThrow();
});

it('Dice permits doubles, shares exact totals, and rejects malformed rolls',()=>{
  const players=[{userId:'b',selection:[12]},{userId:'a',selection:[12]},{userId:'c',selection:[7]}];
  expect(pvpWinnerIds('dice',players,[6,6])).toEqual(['a','b']);
  expect(pvpWinnerIds('dice',players,[1,1])).toEqual([]);
  expect(validatePvpSelection('dice',[7])).toEqual([7]);
  for(const selection of [[1],[13],[7,8],[2.5]])expect(()=>validatePvpSelection('dice',selection)).toThrow();
  for(const outcome of [[0,6],[6,7],[1],[1,2,3]])expect(()=>pvpWinnerIds('dice',players,outcome)).toThrow();
});
