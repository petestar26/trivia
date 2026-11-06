import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { togetherSelection, type TogetherGame } from '@socialplay/shared';
import { TogetherSelection } from './play-together-selection';

afterEach(cleanup);
function mount(game: TogetherGame, disabled = false, initial: number[] = []) {
  const onChange = vi.fn();
  function Selection() {
    const [selected, setSelected] = useState(initial),
      [text, setText] = useState('');
    return (
      <TogetherSelection
        game={game}
        selected={selected}
        disabled={disabled}
        onChange={(v) => {
          setSelected(v);
          onChange(v);
        }}
        crashText={text}
        onCrashText={setText}
      />
    );
  }
  render(<Selection />);
  return onChange;
}
it.each(['roulette_keno', 'lucky_six'] as const)(
  '%s enforces number limits and lets a member change a pick',
  (game) => {
    const changed = mount(game),
      count = game === 'lucky_six' ? 6 : 5;
    for (let n = 1; n <= count + 1; n++)
      fireEvent.click(screen.getByRole('button', { name: 'Choose ' + n }));
    expect(changed.mock.lastCall?.[0]).toHaveLength(count);
    expect(() => togetherSelection(game, changed.mock.lastCall?.[0])).not.toThrow();
    fireEvent.click(screen.getByRole('button', { name: 'Choose 1' }));
    expect(changed.mock.lastCall?.[0]).toHaveLength(count - 1);
  }
);
it.each(['thunder_derby_3d', 'neon_hounds_3d'] as const)(
  '%s keeps exactly one clearly named runner',
  (game) => {
    const changed = mount(game),
      label = game === 'neon_hounds_3d' ? 'dog' : 'runner';
    fireEvent.click(screen.getByRole('button', { name: `Choose ${label} 2` }));
    fireEvent.click(screen.getByRole('button', { name: `Choose ${label} 8` }));
    expect(changed.mock.lastCall?.[0]).toEqual([8]);
  }
);
it.each(['blackjack', 'virtual_football_3d'] as const)(
  '%s requires every prediction and preserves their order',
  (game) => {
    const changed = mount(game),
      fields = screen.getAllByRole('combobox');
    fireEvent.change(fields[fields.length - 1], { target: { value: '2' } });
    expect(() => togetherSelection(game, changed.mock.lastCall?.[0])).toThrow();
    fields.forEach((field, i) => fireEvent.change(field, { target: { value: String(i % 3) } }));
    expect(togetherSelection(game, changed.mock.lastCall?.[0])).toEqual(
      fields.map((_, i) => i % 3)
    );
  }
);
it.each(['sky_crash', 'crash_point'] as const)(
  '%s explains survival separately and rejects excess precision',
  (game) => {
    const changed = mount(game),
      input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '2.00' } });
    expect(changed.mock.lastCall?.[0]).toEqual([200]);
    expect(screen.getByText(/does not guarantee winning/)).toHaveTextContent('49.75%');
    fireEvent.change(input, { target: { value: '2.001' } });
    expect(changed.mock.lastCall?.[0]).toEqual([]);
  }
);
it('locked selections cannot be changed', () => {
  const changed = mount('thunder_derby_3d', true, [2]);
  fireEvent.click(screen.getByRole('button', { name: 'Choose runner 8' }));
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Choose runner 2' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});
