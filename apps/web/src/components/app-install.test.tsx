import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AppInstallProvider,
  InstallAppButton,
  InstallAppCard,
  installationGuide,
} from './app-install';

const dismissalKey = 'salem-install-promo-dismissed-at';
function mount() {
  return render(
    <AppInstallProvider>
      <InstallAppButton />
      <InstallAppCard />
      <input aria-label="Signup draft" defaultValue="my_unsent_name" />
    </AppInstallProvider>
  );
}
function offer(
  outcome: 'accepted' | 'dismissed' = 'accepted',
  prompt = vi.fn().mockResolvedValue(undefined)
) {
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}
beforeEach(() => {
  vi.mocked(localStorage.getItem).mockReset().mockReturnValue(null);
  vi.mocked(localStorage.setItem).mockReset();
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('promotes installation without opening a browser prompt until a user asks', async () => {
  mount();
  const offered = offer();
  expect(offered.defaultPrevented).toBe(true);
  expect(offered.prompt).not.toHaveBeenCalled();
  const card = screen.getByRole('complementary', { name: 'Get the Salem Bet app' });
  fireEvent.click(within(card).getByRole('button', { name: 'Install app' }));
  await waitFor(() => expect(offered.prompt).toHaveBeenCalledTimes(1));
  // Acceptance is not fabricated as completion: the browser confirms installation.
  act(() => {
    window.dispatchEvent(new Event('appinstalled'));
  });
  expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
  expect(screen.queryByRole('complementary')).toBeNull();
});

it('uses a prompt once and provides manual instructions after dismissal', async () => {
  mount();
  const offered = offer('dismissed');
  fireEvent.click(screen.getAllByRole('button', { name: 'Install app' })[0]);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Install app' })[0]).toBeEnabled()
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Install app' })[0]);
  expect(await screen.findByRole('dialog', { name: 'Install Salem Bet' })).toBeVisible();
  expect(offered.prompt).toHaveBeenCalledTimes(1);
});

it('recovers a failed native prompt with usable instructions', async () => {
  mount();
  offer('accepted', vi.fn().mockRejectedValue(new Error('Browser refused')));
  fireEvent.click(screen.getAllByRole('button', { name: 'Install app' })[0]);
  const guide = await screen.findByRole('dialog');
  expect(within(guide).getByRole('status')).toHaveTextContent('steps below');
  expect(within(guide).getByRole('list')).toBeVisible();
});

it('opens and closes accessible guidance without losing the signup draft', async () => {
  mount();
  const help = screen.getByRole('button', { name: 'How to install' });
  help.focus();
  fireEvent.click(help);
  const guide = await screen.findByRole('dialog', { name: 'Install Salem Bet' });
  expect(within(guide).getByText(/without installing/)).toBeVisible();
  fireEvent.keyDown(guide, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(help).toHaveFocus());
  expect(screen.getByRole('textbox', { name: 'Signup draft' })).toHaveValue('my_unsent_name');
});

it('offers a newly available native prompt inside an already open guide', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'How to install' }));
  const event = offer();
  fireEvent.click(await screen.findByRole('button', { name: 'Install now' }));
  await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1));
});

it('lets users dismiss the reminder while keeping the install button available', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss install reminder' }));
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(screen.getByRole('button', { name: 'Install app' })).toBeVisible();
  expect(localStorage.setItem).toHaveBeenCalledWith(dismissalKey, expect.any(String));
});

it.each([true, false])('respects reminder expiration (recent=%s)', (recent) => {
  vi.mocked(localStorage.getItem).mockReturnValue(String(Date.now() - (recent ? 1 : 8) * 86400000));
  mount();
  expect(screen.queryByRole('complementary') !== null).toBe(!recent);
  expect(screen.getAllByRole('button', { name: 'Install app' }).length).toBeGreaterThan(0);
});

it('works when storage is unavailable', () => {
  vi.mocked(localStorage.getItem).mockImplementation(() => {
    throw Error('Storage blocked');
  });
  vi.mocked(localStorage.setItem).mockImplementation(() => {
    throw Error('Storage blocked');
  });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss install reminder' }));
  expect(screen.getByRole('button', { name: 'Install app' })).toBeVisible();
});

it('hides installation offers inside the installed app', () => {
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  );
  mount();
  expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
  expect(screen.queryByRole('complementary')).toBeNull();
});

it.each([
  ['Mozilla iPhone Safari', 'iPhone', 5, 'iPhone or iPad', 'Home Screen'],
  ['Mozilla Macintosh Safari', 'MacIntel', 5, 'iPhone or iPad', 'Home Screen'],
  ['Mozilla Android Chrome', 'Linux', 5, 'Android', 'Home screen'],
  ['Mozilla Macintosh Safari', 'MacIntel', 0, 'Safari on Mac', 'Dock'],
  ['Mozilla Macintosh Chrome Safari', 'MacIntel', 0, 'Computer', 'address bar'],
  ['Mozilla Firefox', 'Win32', 0, 'Computer', 'Chrome or Edge'],
])('provides instructions for %s', (ua, platform, touch, device, text) => {
  const guide = installationGuide(ua as string, platform as string, touch as number);
  expect(guide.device).toBe(device);
  expect(guide.steps.join(' ')).toContain(text);
  expect(guide.help).toMatch(/^https:\/\/support\.(apple|google)\.com\//);
});
