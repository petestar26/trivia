import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  post: vi.fn(),
  navigate: vi.fn(),
  user: { id: 'member' } as { id: string } | null,
}));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<any>('@/lib/api')),
  api: { post: f.post },
}));
vi.mock('@/lib/sports-launch', async () => ({
  ...(await vi.importActual<any>('@/lib/sports-launch')),
  navigateToSportsbook: f.navigate,
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: f.user }) }));
import { SportsLaunchPage } from './sports-launch';
const ready = (url = 'https://sports.example.com/session') => ({
  success: true,
  data: { mode: 'real-wallet', url },
});
const tree = () => (
  <StrictMode>
    <MemoryRouter>
      <SportsLaunchPage />
    </MemoryRouter>
  </StrictMode>
);
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  f.post.mockResolvedValue(ready());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  f.user = { id: 'member' };
});
it('requests one real-wallet session and redirects despite StrictMode replay', async () => {
  render(tree());
  await waitFor(() =>
    expect(f.navigate).toHaveBeenCalledWith('https://sports.example.com/session')
  );
  expect(f.post).toHaveBeenCalledTimes(1);
  expect(f.navigate).toHaveBeenCalledTimes(1);
  expect(f.post).toHaveBeenCalledWith('/sportsbook/launch', { mobile: false });
});
it('requests the provider mobile layout on narrow screens', async () => {
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  render(tree());
  await waitFor(() => expect(f.navigate).toHaveBeenCalled());
  expect(f.post).toHaveBeenCalledWith('/sportsbook/launch', { mobile: true });
});
it.each([
  'http://sports.example.com',
  'https://name:password@sports.example.com',
  'javascript:alert(1)',
])('refuses unsafe launch URL %s', async (url) => {
  f.post.mockResolvedValue(ready(url));
  render(tree());
  expect(await screen.findByRole('alert')).toHaveTextContent('Sports could not be opened');
  expect(f.navigate).not.toHaveBeenCalled();
});
it('refuses practice-wallet sessions', async () => {
  f.post.mockResolvedValue({
    success: true,
    data: { mode: 'virtual-test', url: 'https://sports.example.com' },
  });
  render(tree());
  await screen.findByRole('alert');
  expect(f.navigate).not.toHaveBeenCalled();
});
it('offers a deliberate retry when the provider is unavailable', async () => {
  f.post.mockRejectedValueOnce(Error('unavailable'));
  render(tree());
  await screen.findByRole('alert');
  expect(f.post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(f.navigate).toHaveBeenCalled());
  expect(f.post).toHaveBeenCalledTimes(2);
});
it('does not redirect after the member leaves the launch page', async () => {
  let resolve!: (value: unknown) => void;
  f.post.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  const view = render(tree());
  view.unmount();
  await act(async () => resolve(ready()));
  expect(f.navigate).not.toHaveBeenCalled();
});
it('discards the previous account session if the signed-in member changes', async () => {
  let resolve!: (value: unknown) => void;
  f.post.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  const view = render(tree());
  f.user = { id: 'another-member' };
  view.rerender(tree());
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
  await act(async () => resolve(ready('https://sports.example.com/old-session')));
  expect(f.navigate).toHaveBeenCalledTimes(1);
  expect(f.navigate).not.toHaveBeenCalledWith('https://sports.example.com/old-session');
});
it('does not request a session for a signed-out visitor', () => {
  f.user = null;
  render(tree());
  expect(screen.getByText('Sign in to browse sports.')).toBeInTheDocument();
  expect(f.post).not.toHaveBeenCalled();
});
