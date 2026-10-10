import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DERBY_RULES, type DerbySnapshot } from '@socialplay/shared';
import { DerbyView } from './thunder-derby';
vi.mock('@/components/derby/race-scene', () => ({ default: () => <div>3D race fixture</div> }));
let data: DerbySnapshot;
beforeEach(() => {
  const now = Date.now();
  data = {
    rulesId: DERBY_RULES.id,
    serverTime: now,
    balance: 1000,
    rounds: [
      {
        id: 'race-6',
        field: 6,
        opensAt: now - 10000,
        startsAt: now + 100000,
        finishesAt: now + 145000,
        endsAt: now + 160000,
        commitment: 'a'.repeat(64),
        order: null,
        seed: null,
        positions: Array(6).fill(0),
        ticket: null,
      },
    ],
  };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
afterEach(cleanup);
function setup(props: Partial<Parameters<typeof DerbyView>[0]> = {}) {
  const submit = vi.fn(),
    field = vi.fn();
  render(
    <MemoryRouter>
      <DerbyView data={data} field={6} onField={field} onSubmit={submit} {...props} />
    </MemoryRouter>
  );
  return { submit, field };
}
it('selects an ordered finish and requires review before submitting', () => {
  const { submit } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Perfecta' }));
  const horses = screen.getByRole('group', { name: 'Choose horses' });
  fireEvent.click(within(horses).getByRole('button', { name: /2 Midnight Blue/ }));
  fireEvent.click(within(horses).getByRole('button', { name: /1 Royal Ember/ }));
  fireEvent.click(screen.getByRole('button', { name: /Review selection/ }));
  expect(submit).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/#2 → #1/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm practice selection' }));
  expect(submit).toHaveBeenCalledWith({
    roundId: 'race-6',
    field: 6,
    market: 'PERFECTA',
    picks: [2, 1],
    stake: 25,
  });
});
it('supports special markets without horse picks and displays the gross return', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Even' }));
  expect(screen.getByText('Winning numbers: 2 · 4 · 6')).toBeInTheDocument();
  expect(screen.getByText('45 credits')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Review selection/ })).toBeEnabled();
});
it.each(['stale', 'closed', 'wrong-rules', 'pending', 'confirmed'])(
  'blocks confirmation when %s',
  (kind) => {
    if (kind === 'closed') data.rounds[0].startsAt = Date.now() - 1;
    if (kind === 'wrong-rules') data.rulesId = 'unknown';
    if (kind === 'confirmed')
      data.rounds[0].ticket = {
        market: 'WIN',
        picks: [1],
        stake: 25,
        oddsCents: 540,
        payout: null,
      };
    setup({
      updatedAt: kind === 'stale' ? Date.now() - 10000 : Date.now(),
      pending:
        kind === 'pending'
          ? { roundId: 'race-6', field: 6, market: 'WIN', picks: [1], stake: 25 }
          : null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Even' }));
    expect(
      screen.getByRole('button', { name: /Review selection|Selections closed|Selection confirmed/ })
    ).toBeDisabled();
  }
);
it('opens readable rules and official race details', () => {
  data.rounds.push({
    ...data.rounds[0],
    id: 'old-race',
    order: [2, 1, 3, 4, 5, 6],
    seed: 'b'.repeat(64),
  });
  setup();
  fireEvent.click(screen.getByRole('button', { name: /How to play/ }));
  expect(screen.getByRole('dialog')).toHaveTextContent('One selection per race');
  fireEvent.click(screen.getByRole('button', { name: 'Close rules' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open result old-race' }));
  expect(
    within(screen.getByRole('dialog')).getByRole('list', { name: 'First to last' }).children
  ).toHaveLength(6);
  expect(screen.getByRole('dialog')).toHaveTextContent('Winner · #2 Midnight Blue');
});
it('switches between six- and eight-runner fields', () => {
  const { field } = setup();
  fireEvent.click(screen.getByRole('button', { name: /8 horses/ }));
  expect(field).toHaveBeenCalledWith(8);
});
it('expands the mounted race display and keeps the ordered selection when minimized', async () => {
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const { submit } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Perfecta' }));
  const choices = screen.getByRole('group', { name: 'Choose horses' });
  const second = within(choices).getByRole('button', { name: /2 Midnight Blue/ });
  const first = within(choices).getByRole('button', { name: /1 Royal Ember/ });
  fireEvent.click(second);
  fireEvent.click(first);
  const scene = await screen.findByText('3D race fixture');
  const review = screen.getByRole('button', { name: /Review selection/ });
  fireEvent.click(screen.getByRole('button', { name: 'Expand Thunder Derby view' }));
  const expanded = screen.getByRole('dialog', { name: 'Thunder Derby expanded view' });
  expect(within(expanded).getByText('3D race fixture')).toBe(scene);
  expect(choices.closest('[inert]')).not.toBeNull();
  fireEvent.click(review);
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.click(within(expanded).getByRole('button', { name: 'Minimize Thunder Derby view' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('3D race fixture')).toBe(scene);
  expect(second).toHaveAttribute('aria-pressed', 'true');
  expect(first).toHaveAttribute('aria-pressed', 'true');
  expect(review).toBeEnabled();
  expect(choices.closest('[inert]')).toBeNull();
  fireEvent.click(review);
  expect(screen.getByRole('dialog')).toHaveTextContent('#2 → #1');
  scroll.mockRestore();
});
it('does not imply first place for a top-three selection', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'In first 3' }));
  fireEvent.click(screen.getByRole('button', { name: /1 Royal Ember/ }));
  expect(screen.getByRole('button', { name: /1 Royal Ember/ })).not.toHaveTextContent('1st');
});
it('uses unordered wording for Quinella review and receipt', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Quinella' }));
  fireEvent.click(screen.getByRole('button', { name: /3 Silver Comet/ }));
  fireEvent.click(screen.getByRole('button', { name: /1 Royal Ember/ }));
  fireEvent.click(screen.getByRole('button', { name: /Review selection/ }));
  expect(screen.getByRole('dialog')).toHaveTextContent('#1 & #3');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('→');
  cleanup();
  data.rounds[0].ticket = {
    market: 'QUINELLA',
    picks: [1, 3],
    stake: 25,
    oddsCents: 1350,
    payout: null,
  };
  setup();
  expect(screen.getByRole('status')).toHaveTextContent('#1 & #3');
  expect(screen.getByRole('status')).not.toHaveTextContent('→');
});

it.each([6, 8] as const)(
  'shows every official finisher above the track for %i runners',
  (field) => {
    const order = field === 6 ? [5, 2, 1, 6, 4, 3] : [8, 2, 7, 6, 4, 3, 1, 5];
    Object.assign(data.rounds[0], { field, order, finishesAt: Date.now() - 1000 });
    setup({ field });
    const result = screen.getByRole('region', { name: 'Official finishing order' });
    const rows = within(result).getAllByRole('listitem');
    expect(rows).toHaveLength(field);
    order.forEach((number, index) => expect(rows[index]).toHaveTextContent(`#${number}`));
    expect(within(result).getByRole('status')).toHaveTextContent(`Winner · #${order[0]}`);
    expect(
      result.compareDocumentPosition(screen.getByText('3D race fixture')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  }
);
it('keeps the latest same-field result visible during the next round', () => {
  const old = {
    ...data.rounds[0],
    id: 'previous',
    finishesAt: Date.now() - 1000,
    order: [3, 1, 2, 4, 6, 5],
  };
  data.rounds.push(old, {
    ...old,
    id: 'older',
    finishesAt: Date.now() - 5000,
    order: [1, 2, 3, 4, 5, 6],
  });
  setup();
  const result = screen.getByRole('region', { name: 'Official finishing order' });
  expect(result).toHaveTextContent('LATEST COMPLETED RACE');
  expect(result).toHaveTextContent('Winner · #3 Silver Comet');
  expect(within(result).getAllByRole('listitem')).toHaveLength(6);
});
it('does not infer a winner from live positions or show another field result', () => {
  data.rounds[0].positions = [0.99, 0.2, 0.1, 0.3, 0.2, 0.1];
  data.rounds.push({
    ...data.rounds[0],
    field: 8,
    id: 'other-field',
    finishesAt: Date.now() - 1000,
    order: [1, 2, 3, 4, 5, 6, 7, 8],
  });
  setup();
  expect(
    screen.queryByRole('region', { name: 'Official finishing order' })
  ).not.toBeInTheDocument();
});

it('waits for the official finish time even if an order is present early', () => {
  data.rounds[0].order = [1, 2, 3, 4, 5, 6];
  setup();
  expect(
    screen.queryByRole('region', { name: 'Official finishing order' })
  ).not.toBeInTheDocument();
});
