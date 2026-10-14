import { lazy, Suspense } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SceneLoadBoundary } from './scene-load-boundary';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('contains a rejected lazy chunk before renderer mount while keeping live text results', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const FailedScene = lazy(() => Promise.reject(Error('404 missing renderer chunk')));
  const view = render(
    <SceneLoadBoundary fallback={<p>Official finish: #2 → #1 → #3</p>}>
      <Suspense fallback="Loading">
        <FailedScene />
      </Suspense>
    </SceneLoadBoundary>
  );
  expect(await screen.findByRole('button', { name: 'Reload game view' })).toBeVisible();
  expect(screen.getByText('Official finish: #2 → #1 → #3')).toBeVisible();
  view.rerender(
    <SceneLoadBoundary fallback={<p>Official finish: #5 → #4 → #6</p>}>
      <Suspense fallback="Loading">
        <FailedScene />
      </Suspense>
    </SceneLoadBoundary>
  );
  expect(screen.getByText('Official finish: #5 → #4 → #6')).toBeVisible();
  expect(screen.queryByText('Official finish: #2 → #1 → #3')).toBeNull();
});
