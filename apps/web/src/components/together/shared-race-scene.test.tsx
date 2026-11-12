import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SharedRaceScene from './shared-race-scene';

const scenes = vi.hoisted(() => ({
  derby: [] as Record<string, unknown>[],
  dogs: [] as Record<string, unknown>[],
}));
vi.mock('@/components/derby/race-scene', () => ({
  default: (props: Record<string, unknown>) => {
    scenes.derby.push(props);
    return <div>Derby course</div>;
  },
}));
vi.mock('@/components/dog-racing/race-scene', () => ({
  default: (props: Record<string, unknown>) => {
    scenes.dogs.push(props);
    return <div>Dog course</div>;
  },
}));

const fallback = <p>Two-dimensional race</p>;
const positions = [0.31, 0.3, 0.33, 0.29, 0.3, 0.32, 0.28, 0.3];
const props = {
  roundId: 'group-race',
  positions,
  elapsed: 14000,
  duration: 32000,
  running: true,
  reduced: false,
  complete: false,
  quality: 'balanced' as const,
  fallback,
};
beforeEach(() => {
  scenes.derby.length = 0;
  scenes.dogs.length = 0;
});
afterEach(cleanup);

function cameras() {
  return within(screen.getByRole('group', { name: 'Camera view' }));
}

it('offers group horse racing the same Trackside, Follow race and Aerial views', () => {
  const onSlow = vi.fn();
  render(<SharedRaceScene {...props} dogs={false} adaptive onSlow={onSlow} />);
  expect(
    cameras()
      .getAllByRole('button')
      .map((b) => b.textContent)
  ).toEqual(['Trackside', 'Follow race', 'Aerial']);
  expect(cameras().getByRole('button', { name: 'Trackside' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(scenes.derby.at(-1)).toMatchObject({ cameraMode: 'trackside' });
  fireEvent.click(cameras().getByRole('button', { name: 'Follow race' }));
  expect(cameras().getByRole('button', { name: 'Follow race' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(cameras().getByRole('button', { name: 'Trackside' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  expect(scenes.derby.at(-1)).toMatchObject({ cameraMode: 'chase' });
  fireEvent.click(cameras().getByRole('button', { name: 'Aerial' }));
  expect(scenes.derby.at(-1)).toMatchObject({ cameraMode: 'aerial' });
  expect(scenes.dogs).toHaveLength(0);
});

it('passes Automatic quality adaptation and overload reports to the horse course', () => {
  const onSlow = vi.fn();
  const view = render(<SharedRaceScene {...props} dogs={false} adaptive onSlow={onSlow} />);
  const scene = scenes.derby.at(-1)!;
  expect(scene).toMatchObject({ adaptive: true, quality: 'balanced', synchronized: true });
  expect(scene.onSlow).toBe(onSlow);
  // The scene reports sustained overload; the group page lowers its tier.
  (scene.onSlow as () => void)();
  expect(onSlow).toHaveBeenCalledOnce();
  // An explicit tier is not adaptive, and the lobby preview omits both props.
  view.rerender(<SharedRaceScene {...props} dogs={false} quality="low" adaptive={false} />);
  expect(scenes.derby.at(-1)).toMatchObject({ adaptive: false, quality: 'low' });
  view.rerender(<SharedRaceScene {...props} dogs={false} />);
  expect(scenes.derby.at(-1)).toMatchObject({ adaptive: false, onSlow: undefined });
});

it('keeps the group 2D fallback and disclosed positions for the horse course', () => {
  const view = render(<SharedRaceScene {...props} dogs={false} />);
  expect(scenes.derby.at(-1)).toMatchObject({
    fallback,
    running: true,
    reduced: false,
    round: { id: 'group-race', positions, field: 8, order: null },
  });
  view.rerender(<SharedRaceScene {...props} dogs={false} complete running={false} />);
  expect(scenes.derby.at(-1)!.round).toMatchObject({ order: [3, 6, 1, 2, 5, 8, 4, 7] });
  // Camera choice is presentation only: the disclosed round is unchanged.
  fireEvent.click(cameras().getByRole('button', { name: 'Aerial' }));
  expect(scenes.derby.at(-1)!.round).toMatchObject({ positions, order: [3, 6, 1, 2, 5, 8, 4, 7] });
});

it('leaves the group dog course wiring unchanged', () => {
  const onSlow = vi.fn();
  render(<SharedRaceScene {...props} dogs adaptive onSlow={onSlow} quality="high" />);
  expect(screen.getByText('Dog course')).toBeInTheDocument();
  expect(scenes.derby).toHaveLength(0);
  const scene = scenes.dogs.at(-1)!;
  expect(scene).toMatchObject({
    cameraMode: 'trackside',
    quality: 'high',
    adaptive: true,
    synchronized: true,
    progressMode: 'shared',
    running: true,
    reduced: false,
  });
  expect(scene.onSlow).toBe(onSlow);
  expect(scene).not.toHaveProperty('fallback');
  fireEvent.click(cameras().getByRole('button', { name: 'Follow race' }));
  expect(scenes.dogs.at(-1)).toMatchObject({ cameraMode: 'chase' });
  expect(document.querySelector('[data-original-scene="dog-racing"]')).toHaveClass('hounds-page');
});
