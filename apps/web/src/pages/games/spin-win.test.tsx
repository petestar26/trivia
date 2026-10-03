import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpinWinPage, practiceNumber } from './spin-win';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function mount() {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SpinWinPage />
    </MemoryRouter>
  );
}
describe('Spin Win practice', () => {
  it('shows a complete number wheel, markets and practice-only terms', () => {
    mount();
    expect(screen.getByRole('img', { name: /0 to 36/ })).toBeInTheDocument();
    expect(screen.getByText(/No Coins are spent or won/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spin' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /Bet on/ })).toHaveLength(52);
  });
  it('adds multiple bets, undoes changes and clears the ticket', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Bet on Red' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bet on 0 green' }));
    expect(screen.getByTestId('spin-total')).toHaveTextContent('80');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('spin-total')).toHaveTextContent('40');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('button', { name: 'Spin' })).toBeDisabled();
  });
  it('locks the board, settles zero once and rebet restores the ticket without spinning', () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint32Array)[0] = 0;
      return array;
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Bet on 0 green' }));
    fireEvent.click(screen.getByRole('button', { name: 'Spin' }));
    expect(screen.getByRole('button', { name: 'Spinning…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bet on Red' })).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(1850);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Return 1332 · Net +1292');
    expect(screen.getByText('2,292')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rebet' }));
    expect(screen.getByTestId('spin-total')).toHaveTextContent('40');
    expect(screen.getByRole('button', { name: 'Spin' })).toBeEnabled();
  });
  it('limits the aggregate practice stake', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '80' }));
    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole('button', { name: 'Bet on Red' }));
    expect(screen.getByTestId('spin-total')).toHaveTextContent('480');
    expect(screen.getByRole('status')).toHaveTextContent('exceeds');
  });
  it('rejects biased tail samples before mapping to a pocket', () => {
    let call = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint32Array)[0] = call++ === 0 ? 0xffffffff : 36;
      return array;
    });
    expect(practiceNumber()).toBe(36);
    expect(call).toBe(2);
  });
  it('allows resetting a residual balance below the 40-credit minimum', () => {
    vi.useFakeTimers();
    let number = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint32Array)[0] = number;
      return array;
    });
    mount();
    for (const [chip, outcome] of [[400, 0], [400, 0], [40, 1], [200, 0]]) {
      number = outcome;
      fireEvent.click(screen.getByRole('button', { name: String(chip) }));
      fireEvent.click(screen.getByRole('button', { name: 'Bet on Red' }));
      fireEvent.click(screen.getByRole('button', { name: 'Spin' }));
      act(() => vi.advanceTimersByTime(1850));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Reset practice credits' }));
    expect(screen.getByRole('status')).toHaveTextContent('Practice credits reset.');
    expect(screen.getByText('1,000')).toBeInTheDocument();
  });
});

it('uses typed stakes for new selections and keeps chips synchronized',()=>{
  mount();
  const input=screen.getByRole('textbox',{name:'Bet amount'});
  fireEvent.change(input,{target:{value:'160'}});
  fireEvent.click(screen.getByRole('button',{name:'Bet on Red'}));
  expect(screen.getByTestId('spin-total')).toHaveTextContent('160');
  fireEvent.change(input,{target:{value:'80'}});
  expect(screen.getByTestId('spin-total')).toHaveTextContent('160');
  fireEvent.click(screen.getByRole('button',{name:'Bet on Black'}));
  expect(screen.getByTestId('spin-total')).toHaveTextContent('240');
  fireEvent.click(screen.getByRole('button',{name:'120'}));
  expect(input).toHaveValue('120');
});
it.each(['','0','-40','41','40.5','1e2','520','999999999999999999999'])('rejects invalid typed stake %s',(value)=>{
  mount(); fireEvent.change(screen.getByRole('textbox',{name:'Bet amount'}),{target:{value}});
  expect(screen.getByRole('textbox',{name:'Bet amount'})).toHaveAttribute('aria-invalid','true');
  expect(screen.getByRole('button',{name:'Bet on Red'})).toBeDisabled();
  expect(screen.getByTestId('spin-total')).toHaveTextContent('0');
});
