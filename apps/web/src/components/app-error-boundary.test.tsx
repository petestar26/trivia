import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './app-error-boundary';
afterEach(() => {
  vi.restoreAllMocks();
});
it('replaces a crashing page with recovery controls without displaying exception details', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  function Broken(): never {
    throw new Error('private-component-state');
  }
  render(
    <AppErrorBoundary>
      <Broken />
    </AppErrorBoundary>
  );
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Return home' }).getAttribute('href')).toBe('/');
  expect(screen.queryByText(/private-component-state/)).toBeNull();
});
it('preserves the page when it renders successfully', () => {
  render(
    <AppErrorBoundary>
      <h1>Wallet</h1>
    </AppErrorBoundary>
  );
  expect(screen.getByRole('heading', { name: 'Wallet' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
