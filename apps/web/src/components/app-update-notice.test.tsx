import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppUpdateNotice } from './app-update-notice';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function worker(initial: object | null) {
  const events = Object.assign(new EventTarget(), { controller: initial });
  vi.stubGlobal('navigator', { serviceWorker: events });
  return (controller: object | null) => act(() => {
    events.controller = controller;
    events.dispatchEvent(new Event('controllerchange'));
  });
}
it('offers one update notice and reloads only when requested', () => {
  const change = worker({}); const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  change({}); change({});
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  expect(reload).toHaveBeenCalledTimes(1);
});
it('ignores first install and duplicate controller events, then detects an upgrade', () => {
  const change = worker(null); const first = {};
  render(<AppUpdateNotice />);
  change(first); change(first);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  change({});
  expect(screen.getByRole('status')).toBeInTheDocument();
});
it('dismisses without reloading or losing a draft and returns only for a new controller', () => {
  const change = worker({}); const reload = vi.fn(); const update = {};
  render(<><input aria-label="Message" defaultValue="Unsent draft" /><AppUpdateNotice reload={reload} /></>);
  change(update);
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unsent draft');
  expect(reload).not.toHaveBeenCalled();
  change(update);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  change({});
  expect(screen.getByRole('status')).toBeInTheDocument();
});
it('supports browsers without service workers', () => {
  vi.stubGlobal('navigator', {});
  render(<AppUpdateNotice />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
