import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppUpdateNotice } from './app-update-notice';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function serviceWorker(state: ServiceWorkerState = 'installed') {
  return Object.assign(new EventTarget(), { state, postMessage: vi.fn() });
}
type MockWorker = ReturnType<typeof serviceWorker>;
function setupWorker({
  firstInstall = false,
  waiting = null,
  installing = null,
}: { firstInstall?: boolean; waiting?: MockWorker | null; installing?: MockWorker | null } = {}) {
  const current = firstInstall ? null : serviceWorker('activated');
  const registration = Object.assign(new EventTarget(), {
    active: current,
    waiting,
    installing,
    update: vi.fn().mockResolvedValue(undefined),
  });
  const workers = Object.assign(new EventTarget(), {
    controller: current,
    register: vi.fn().mockResolvedValue(registration),
  });
  vi.stubGlobal('navigator', { serviceWorker: workers });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const changeController = (next: MockWorker | null) =>
    act(() => {
      workers.controller = next;
      workers.dispatchEvent(new Event('controllerchange'));
    });
  const changeState = (worker: MockWorker, state: ServiceWorkerState) =>
    act(() => {
      worker.state = state;
      worker.dispatchEvent(new Event('statechange'));
    });
  return { current, registration, workers, changeController, changeState };
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

it('registers manually and notices an already waiting upgrade before activation', async () => {
  const waiting = serviceWorker();
  const { workers } = setupWorker({ waiting });
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await screen.findByRole('status', { name: 'App update available' });
  expect(workers.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  expect(waiting.postMessage).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
it('observes updatefound and installation without activating the update', async () => {
  const { registration, changeState } = setupWorker();
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await settle();
  const installing = serviceWorker('installing');
  act(() => {
    registration.installing = installing;
    registration.dispatchEvent(new Event('updatefound'));
  });
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  changeState(installing, 'installed');
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(installing.postMessage).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
it('ignores first installation and its first controller event', async () => {
  const installing = serviceWorker('installing');
  const { registration, changeState, changeController } = setupWorker({
    firstInstall: true,
    installing,
  });
  render(<AppUpdateNotice />);
  await settle();
  registration.waiting = installing;
  changeState(installing, 'installed');
  changeState(installing, 'activated');
  changeController(installing);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(installing.postMessage).not.toHaveBeenCalled();
});
it('recognizes an already waiting upgrade when the current tab is uncontrolled', async () => {
  const waiting = serviceWorker();
  const { workers } = setupWorker({ waiting });
  workers.controller = null;
  render(<AppUpdateNotice />);
  await screen.findByRole('status');
  expect(waiting.postMessage).not.toHaveBeenCalled();
});
it('Later preserves the draft and controller, and checks do not redisplay the same update', async () => {
  const waiting = serviceWorker();
  const { workers, current, registration } = setupWorker({ waiting });
  const reload = vi.fn();
  render(
    <>
      <input aria-label="Message" defaultValue="Unsent draft" />
      <AppUpdateNotice reload={reload} />
    </>
  );
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  fireEvent(window, new Event('focus'));
  fireEvent(window, new Event('online'));
  await settle();
  expect(registration.update).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unsent draft');
  expect(workers.controller).toBe(current);
  expect(waiting.postMessage).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
it('activates only on Reload app and reloads once after activation, never on detection', async () => {
  const waiting = serviceWorker();
  const { changeState, changeController } = setupWorker({ waiting });
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }));
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  changeState(waiting, 'activating');
  expect(reload).not.toHaveBeenCalled();
  changeState(waiting, 'activated');
  expect(reload).not.toHaveBeenCalled();
  changeController(waiting);
  changeState(waiting, 'activated');
  expect(reload).toHaveBeenCalledTimes(1);
});
it('finishes a requested activation on controllerchange without a delivered state event', async () => {
  const waiting = serviceWorker();
  const { changeController } = setupWorker({ waiting });
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  waiting.state = 'activated';
  changeController(waiting);
  expect(reload).toHaveBeenCalledTimes(1);
});
it('waits for an offered worker whose activation was started by another tab', async () => {
  const waiting = serviceWorker();
  const { registration, changeState, changeController } = setupWorker({ waiting });
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await screen.findByRole('status');
  registration.waiting = null;
  registration.installing = null;
  registration.active = waiting;
  changeState(waiting, 'activating');
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  expect(reload).not.toHaveBeenCalled();
  expect(waiting.postMessage).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  changeState(waiting, 'activated');
  changeController(waiting);
  expect(reload).toHaveBeenCalledTimes(1);
});
it.each(['offered', 'registration active'])(
  'retains an already activated %s worker until it controls this tab',
  async (source) => {
    const target = serviceWorker();
    const { registration, changeState, changeController } = setupWorker({
      waiting: source === 'offered' ? target : null,
    });
    const reload = vi.fn();
    render(<AppUpdateNotice reload={reload} />);
    await settle();
    registration.waiting = null;
    registration.installing = null;
    registration.active = target;
    changeState(target, 'activated');
    if (source === 'registration active')
      fireEvent(window, new Event('playqube:app-update-needed'));
    fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(target.postMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
    changeController(target);
    expect(reload).toHaveBeenCalledTimes(1);
  }
);
it('lets an uncontrolled tab reload after activation to acquire the new worker', async () => {
  const waiting = serviceWorker();
  const { workers, changeState } = setupWorker({ waiting });
  workers.controller = null;
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  changeState(waiting, 'activated');
  expect(workers.controller).toBeNull();
  expect(reload).toHaveBeenCalledTimes(1);
});
it('accepts matching controller identity when its change event was not delivered', async () => {
  const waiting = serviceWorker();
  const { workers, changeState } = setupWorker({ waiting });
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  workers.controller = waiting;
  changeState(waiting, 'activated');
  expect(reload).toHaveBeenCalledTimes(1);
});
it('bounds failed activation and permits retry without reloading on late activation', async () => {
  vi.useFakeTimers();
  const waiting = serviceWorker();
  const { changeState, changeController } = setupWorker({ waiting });
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByText(/update could not finish/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reload app' })).toBeEnabled();
  expect(reload).not.toHaveBeenCalled();
  changeState(waiting, 'activated');
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  expect(reload).not.toHaveBeenCalled();
  changeController(waiting);
  expect(reload).toHaveBeenCalledTimes(1);
});
it('recovers failed registration on an explicit retry', async () => {
  const waiting = serviceWorker();
  const { workers, registration, changeState, changeController } = setupWorker({ waiting });
  workers.register.mockRejectedValueOnce(new Error('Offline'));
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await settle();
  fireEvent(window, new Event('playqube:app-update-needed'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  expect(workers.register).toHaveBeenCalledTimes(2);
  expect(registration.waiting?.postMessage).toHaveBeenCalledTimes(1);
  changeState(waiting, 'activated');
  expect(reload).not.toHaveBeenCalled();
  changeController(waiting);
  expect(reload).toHaveBeenCalledTimes(1);
});
it('leaves retry available when activation becomes redundant or sending fails', async () => {
  const waiting = serviceWorker();
  const { registration, changeState } = setupWorker({ waiting });
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  changeState(waiting, 'redundant');
  expect(screen.getByRole('button', { name: 'Reload app' })).toBeEnabled();
  const replacement = serviceWorker();
  replacement.postMessage.mockImplementation(() => {
    throw new Error('Cannot message');
  });
  registration.waiting = replacement;
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  expect(screen.getByText(/update could not finish/)).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
});
it('retries a stalled registration and ignores its late result', async () => {
  vi.useFakeTimers();
  const waiting = serviceWorker();
  const { workers, registration, changeState, changeController } = setupWorker({ waiting });
  let resolveFirst!: (value: typeof registration) => void;
  workers.register.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFirst = resolve;
    })
  );
  const add = vi.spyOn(registration, 'addEventListener');
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await settle();
  fireEvent(window, new Event('playqube:app-update-needed'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByRole('button', { name: 'Reload app' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  expect(workers.register).toHaveBeenCalledTimes(2);
  expect(waiting.postMessage).toHaveBeenCalledTimes(1);
  act(() => resolveFirst(registration));
  await settle();
  expect(add).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
  changeState(waiting, 'activated');
  expect(reload).not.toHaveBeenCalled();
  changeController(waiting);
  expect(reload).toHaveBeenCalledTimes(1);
});
it('resumes checks after a stalled registration and fences stale check completion', async () => {
  vi.useFakeTimers();
  const waiting = serviceWorker();
  waiting.postMessage.mockImplementation(() => {
    throw new Error('Activation failed');
  });
  const { workers, registration } = setupWorker({ waiting });
  let resolveFirst!: (value: typeof registration) => void;
  workers.register.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFirst = resolve;
    })
  );
  let resolveUpdate!: () => void;
  registration.update.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    })
  );
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await settle();
  fireEvent(window, new Event('focus'));
  fireEvent(window, new Event('playqube:app-update-needed'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  act(() => vi.advanceTimersByTime(10_000));
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  expect(workers.register).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Reload app' })).toBeEnabled();
  fireEvent(window, new Event('focus'));
  await settle();
  expect(registration.update).toHaveBeenCalledTimes(1);
  act(() => resolveFirst(registration));
  await settle();
  fireEvent(window, new Event('focus'));
  await settle();
  expect(registration.update).toHaveBeenCalledTimes(1);
  act(() => resolveUpdate());
  await settle();
  fireEvent(window, new Event('online'));
  await settle();
  expect(registration.update).toHaveBeenCalledTimes(2);
  act(() => vi.advanceTimersByTime(60_000));
  await settle();
  expect(registration.update).toHaveBeenCalledTimes(3);
  expect(reload).not.toHaveBeenCalled();
});
it('notifies about another tab or legacy activation without reloading', async () => {
  const { changeController } = setupWorker();
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await settle();
  const next = serviceWorker('activated');
  changeController(next);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  changeController(next);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  changeController(serviceWorker('activated'));
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
});
it('shows preload-error notice, preserves the draft, and reloads only on click', async () => {
  setupWorker();
  const reload = vi.fn();
  render(
    <>
      <input aria-label="Message" defaultValue="Unsent draft" />
      <AppUpdateNotice reload={reload} />
    </>
  );
  await settle();
  fireEvent(window, new Event('playqube:app-update-needed'));
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unsent draft');
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  expect(reload).toHaveBeenCalledTimes(1);
});
it('checks only when visible and never reloads on focus, online or interval', async () => {
  vi.useFakeTimers();
  const { registration } = setupWorker();
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  await settle();
  visibility.mockReturnValue('hidden');
  fireEvent(window, new Event('focus'));
  fireEvent(window, new Event('online'));
  act(() => vi.advanceTimersByTime(60_000));
  await settle();
  expect(registration.update).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  await settle();
  expect(registration.update).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(60_000));
  await settle();
  expect(registration.update).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
});
it('cleans listeners, timers and pending activation on unmount', async () => {
  vi.useFakeTimers();
  const waiting = serviceWorker();
  const { registration, changeController, changeState } = setupWorker({ waiting });
  const remove = vi.spyOn(waiting, 'removeEventListener');
  const reload = vi.fn();
  const { unmount } = render(<AppUpdateNotice reload={reload} />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith('statechange', expect.any(Function));
  changeState(waiting, 'activated');
  changeController(waiting);
  fireEvent(window, new Event('focus'));
  fireEvent(window, new Event('playqube:app-update-needed'));
  act(() => vi.advanceTimersByTime(60_000));
  expect(registration.update).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
it('ignores late registration after StrictMode cleanup without duplicate listeners', async () => {
  const waiting = serviceWorker();
  const { workers, registration } = setupWorker({ waiting });
  let resolveFirst!: (value: typeof registration) => void;
  workers.register.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFirst = resolve;
    })
  );
  const add = vi.spyOn(registration, 'addEventListener');
  const remove = vi.spyOn(registration, 'removeEventListener');
  const { unmount } = render(
    <StrictMode>
      <AppUpdateNotice />
    </StrictMode>
  );
  await settle();
  expect(workers.register).toHaveBeenCalledTimes(2);
  await screen.findByRole('status');
  act(() => resolveFirst(registration));
  await settle();
  expect(add).toHaveBeenCalledTimes(1);
  unmount();
  expect(remove).toHaveBeenCalledWith('updatefound', expect.any(Function));
});
it('supports browsers without workers and the manual preload-error fallback', async () => {
  vi.stubGlobal('navigator', {});
  const reload = vi.fn();
  render(<AppUpdateNotice reload={reload} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent(window, new Event('playqube:app-update-needed'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
  await settle();
  expect(reload).toHaveBeenCalledTimes(1);
});
