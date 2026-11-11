import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { GuestAuthProvider, useGuestAuth } from './guest-auth-prompt';

let router: {
  state: { location: ReturnType<typeof useLocation> };
  navigate: ReturnType<typeof useNavigate>;
};
function Actions() {
  const navigate = useNavigate();
  const { requestSignIn } = useGuestAuth();
  const location = useLocation();
  router = { state: { location }, navigate };
  return (
    <>
      <button onClick={() => requestSignIn('Sign in to send a gift.')}>Send gift</button>
      <output data-testid="location">{JSON.stringify(location)}</output>
    </>
  );
}
function setup(path = '/casino?provider=private#launch') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <GuestAuthProvider>
        <Actions />
      </GuestAuthProvider>
    </MemoryRouter>
  );
  return {
    get state() {
      return router.state;
    },
    navigate: (destination: string | number) =>
      typeof destination === 'number' ? router.navigate(destination) : router.navigate(destination),
  };
}

describe('GuestAuthProvider', () => {
  it('opens an accessible prompt without changing history and restores focus on cancel', async () => {
    const router = setup();
    const original = router.state.location;
    const button = screen.getByRole('button', { name: 'Send gift' });
    await act(async () => {
      await userEvent.click(button);
    });
    expect(screen.getByRole('dialog', { name: 'Sign in to continue' })).toHaveAccessibleDescription(
      'Sign in to send a gift.'
    );
    expect(router.state.location).toEqual(original);
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Keep browsing' }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
    expect(router.state.location).toEqual(original);
  });
  it('supports repeated requests, Escape, and the close button', async () => {
    setup();
    const button = screen.getByRole('button', { name: 'Send gift' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await act(async () => {
      await userEvent.keyboard('{Escape}');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => {
      await userEvent.click(button);
    });
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Close sign-in prompt' }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('traps keyboard focus inside the dialog', async () => {
    setup();
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Send gift' }));
    });
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await userEvent.tab();
      });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
  it.each([
    ['Sign in', '/login'],
    ['Create account', '/register'],
  ])('sends %s only a safe browsing destination', async (name, destination) => {
    const router = setup('/groups/invite/secret?token=secret#accept');
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Send gift' }));
    });
    await act(async () => {
      await userEvent.click(screen.getByRole('link', { name }));
    });
    expect(router.state.location.pathname).toBe(destination);
    expect(router.state.location.state).toEqual({
      from: { pathname: '/groups', search: '', hash: '' },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('dismisses on navigation and does not reopen on back/forward', async () => {
    const router = setup();
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Send gift' }));
    });
    await act(async () => {
      await router.navigate('/sports');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/casino'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Send gift' }));
    });
    await act(async () => {
      await router.navigate(1);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('does not restore focus to a still-mounted opener after navigating', async () => {
    const router = setup();
    const opener = screen.getByRole('button', { name: 'Send gift' });
    await act(async () => {
      await userEvent.click(opener);
    });
    const focus = vi.spyOn(opener, 'focus');
    await act(async () => {
      router.navigate('/sports');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(opener.isConnected).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
  });
  it('safely supports a consumer outside the provider', () => {
    render(
      <MemoryRouter>
        <Actions />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send gift' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });
});
