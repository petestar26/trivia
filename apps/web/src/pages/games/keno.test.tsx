import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KenoPage } from './keno';
import { advanceKeno, newKenoState, startKeno } from '@/lib/keno-practice';
const wallet=vi.hoisted(()=>({coinsBalance:2500,walletLoading:false,walletError:false}));
vi.mock('@/components/casino/CasinoProvider',()=>({useCasino:()=>wallet}));
const auth=vi.hoisted(()=>({user:{id:'keno-a'}}));
vi.mock('@/providers/auth-provider',()=>({useAuth:()=>auth}));
const mount=()=>render(<MemoryRouter><KenoPage/></MemoryRouter>);
beforeEach(()=>{wallet.coinsBalance=2500;wallet.walletLoading=false;wallet.walletError=false;sessionStorage.clear();auth.user={id:'keno-a'};vi.useFakeTimers();vi.setSystemTime(100000);});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('locks selections, resumes a refreshed draw, and settles it once',()=>{
  const first=mount();
  fireEvent.click(screen.getByRole('button',{name:'Number 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Start draw · 5 credits'}));
  expect(screen.getByRole('button',{name:'Number 2'})).toBeDisabled();
  act(()=>vi.advanceTimersByTime(1950));
  const stored=JSON.parse(sessionStorage.getItem('playqube.keno.practice.v1.keno-a')!);
  expect(stored.balance).toBe(995);
  first.unmount(); mount();
  expect(screen.getByRole('status')).toHaveTextContent('3 of 20 revealed');
  act(()=>vi.advanceTimersByTime(12000));
  expect(screen.getByRole('status')).toHaveTextContent('credits returned');
  const end=JSON.parse(sessionStorage.getItem('playqube.keno.practice.v1.keno-a')!);
  expect(end.balance).toBe(995+(stored.active.numbers.includes(1)?18:0));
  expect(end.history).toHaveLength(1);
  act(()=>vi.advanceTimersByTime(20000));
  expect(JSON.parse(sessionStorage.getItem('playqube.keno.practice.v1.keno-a')!).balance).toBe(end.balance);
});
it('isolates a new account even when the route remains mounted',()=>{
  const view=mount(); fireEvent.click(screen.getByRole('button',{name:'Number 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Start draw · 5 credits'}));
  auth.user={id:'keno-b'}; view.rerender(<MemoryRouter><KenoPage/></MemoryRouter>);
  expect(screen.getByRole('status')).toHaveTextContent('Select your numbers');
  expect(JSON.parse(sessionStorage.getItem('playqube.keno.practice.v1.keno-b')!).balance).toBe(1000);
  expect(JSON.parse(sessionStorage.getItem('playqube.keno.practice.v1.keno-a')!).active).not.toBeNull();
});
it('limits selection to ten numbers and quick-picks five unique numbers',()=>{
  mount(); for(let n=1;n<=11;n++)fireEvent.click(screen.getByRole('button',{name:`Number ${n}`}));
  expect(screen.getAllByRole('button',{pressed:true})).toHaveLength(10);
  expect(screen.getByText('You can choose up to 10 numbers.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Quick pick 5'}));
  expect(screen.getAllByRole('button',{pressed:true})).toHaveLength(5);
});

it('keeps next-ticket selection visible on a previous hit and a drawn number',()=>{
  const state=advanceKeno(startKeno(newKenoState(),[1],0,Array.from({length:20},(_,i)=>i+1)),20000);
  sessionStorage.setItem('playqube.keno.practice.v1.keno-a',JSON.stringify(state));
  mount();
  for(const label of ['Number 1, drawn, match','Number 2, drawn']){
    const button=screen.getByRole('button',{name:label});
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed','true');
    expect(button.querySelector('.keno-selection-mark')).toBeInTheDocument();
    fireEvent.click(button);
    expect(button.querySelector('.keno-selection-mark')).toBeNull();
  }
});

it('shows account funds separately and quotes a typed stake without spending Coins',()=>{
  mount(); expect(screen.getByText('2,500 Coins')).toBeInTheDocument();
  const input=screen.getByRole('textbox',{name:'Bet amount per number'});
  fireEvent.change(input,{target:{value:'20'}});
  fireEvent.click(screen.getByRole('button',{name:'Number 1'}));
  fireEvent.click(screen.getByRole('button',{name:'Number 2'}));
  expect(screen.getByText('Each match returns 72 credits')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Start draw · 40 credits'}));
  expect(input).toBeDisabled();
  const state=JSON.parse(sessionStorage.getItem('playqube.keno.practice.v1.keno-a')!);
  expect(state.balance).toBe(960); expect(state.active.stakePerNumber).toBe(20);
  expect(screen.getByText('2,500 Coins')).toBeInTheDocument();
});
it.each(['','0','-5','6','5.5','500','1e2'])('blocks invalid stake %s',value=>{
  mount(); fireEvent.click(screen.getByRole('button',{name:'Number 1'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Bet amount per number'}),{target:{value}});
  expect(screen.getByRole('button',{name:/Start draw/})).toBeDisabled();
});
it('blocks an aggregate stake above the ticket limit',()=>{
  mount();fireEvent.change(screen.getByRole('textbox',{name:'Bet amount per number'}),{target:{value:'250'}});
  fireEvent.click(screen.getByRole('button',{name:'Number 1'}));fireEvent.click(screen.getByRole('button',{name:'Number 2'}));
  expect(screen.getByRole('button',{name:'Start draw · 500 credits'})).toBeDisabled();
});
it.each(['walletLoading','walletError'] as const)('does not show a fabricated wallet balance during %s',key=>{
  wallet[key]=true;mount();expect(screen.queryByText('2,500 Coins')).not.toBeInTheDocument();
  expect(screen.getByText(key==='walletLoading'?'Loading…':'Unavailable')).toBeInTheDocument();
});
