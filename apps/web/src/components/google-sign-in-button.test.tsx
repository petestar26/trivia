import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock googleClientId to control visibility.
const mockGoogleClientId = vi.fn();
const mockGoogleNonce = vi.fn();
vi.mock('@/lib/api', () => ({
  googleClientId: (...a: unknown[]) => mockGoogleClientId(...a),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    googleNonce: (...a: unknown[]) => mockGoogleNonce(...a),
    googleAuth: vi.fn(),
  },
}));

// Mock useAuth so the button never touches the real provider.
const mockGoogleAuthenticate = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    googleAuthenticate: mockGoogleAuthenticate,
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));

import { GoogleSignInButton } from './google-sign-in-button';

let capturedCallback: ((response: { credential?: string }) => void) | undefined;
const mockInitialize = vi.fn();
const mockRenderButton = vi.fn();
const mockPrompt = vi.fn();

function triggerCallback(response: { credential?: string }) {
  if (!capturedCallback) throw new Error('callback not captured');
  return capturedCallback(response);
}

beforeEach(() => {
  mockGoogleClientId.mockReset();
  mockGoogleAuthenticate.mockReset();
  mockGoogleNonce.mockReset();
  mockInitialize.mockReset();
  mockRenderButton.mockReset();
  mockPrompt.mockReset();
  capturedCallback = undefined;

  mockGoogleClientId.mockReturnValue('client-123');
  // Nonce data comes ONLY from the ApiClient mock (googleNonce) — a global
  // fetch stub must never be the source of the nonce, which is exactly the
  // production-origin defect this regression guards against.
  mockGoogleNonce.mockResolvedValue({ success: true, data: { nonce: 'NONCE-VALUE' } });
  mockInitialize.mockImplementation((opts: { callback: (response: { credential?: string }) => void }) => {
    capturedCallback = opts.callback;
  });
  mockRenderButton.mockImplementation(() => {});
  (globalThis as never as { google: unknown }).google = {
    accounts: {
      id: {
        initialize: mockInitialize,
        renderButton: mockRenderButton,
        prompt: mockPrompt,
      },
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('GoogleSignInButton', () => {
  it('renders nothing when VITE_GOOGLE_CLIENT_ID is missing', () => {
    mockGoogleClientId.mockReturnValue(undefined);
    const { container } = render(<GoogleSignInButton />);
    expect(container.innerHTML).toBe('');
  });

  it('does not call initialize without a client id', async () => {
    mockGoogleClientId.mockReturnValue(undefined);
    render(<GoogleSignInButton />);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('routes the nonce through ApiClient, initializes GIS with FedCM, and renders the Google button', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<GoogleSignInButton />);
    await waitFor(() => expect(mockInitialize).toHaveBeenCalledTimes(1));
    expect(mockRenderButton).toHaveBeenCalledTimes(1);
    const initArgs = mockInitialize.mock.calls[0][0] as {
      client_id: string;
      nonce: string;
      use_fedcm_for_button?: boolean;
      auto_select?: unknown;
      button_auto_select?: unknown;
    };
    expect(initArgs.client_id).toBe('client-123');
    expect(initArgs.nonce).toBe('NONCE-VALUE');
    expect(initArgs.use_fedcm_for_button).toBe(true);
    // One Tap / auto-select remain OFF.
    expect(initArgs.auto_select).not.toBe(true);
    expect(initArgs.button_auto_select).not.toBe(true);
    expect(mockPrompt).not.toHaveBeenCalled();
    // The nonce came from the ApiClient, never a hardcoded relative fetch.
    expect(mockGoogleNonce).toHaveBeenCalledTimes(1);
    expect(mockGoogleNonce).toHaveBeenCalledWith();
    const nonceUrlCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/v1/auth/google/nonce'));
    expect(nonceUrlCalls).toHaveLength(0);
  });

  it('surfaces a friendly error when the nonce request fails', async () => {
    mockGoogleNonce.mockResolvedValue({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Google sign-in temporarily unavailable' },
    });
    render(<GoogleSignInButton />);
    await waitFor(() => {
      expect(screen.getByText('Google sign-in is temporarily unavailable')).toBeInTheDocument();
    });
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('handles the normal credential callback via googleAuthenticate', async () => {
    mockGoogleAuthenticate.mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    render(<GoogleSignInButton onSuccess={onSuccess} />);
    await waitFor(() => expect(capturedCallback).toBeTruthy());

    triggerCallback({ credential: 'google-jwt' });
    await waitFor(() => expect(mockGoogleAuthenticate).toHaveBeenCalledWith({ credential: 'google-jwt' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Signing in/)).not.toBeInTheDocument();
  });

  it('maps invalid credentials to a friendly generic error', async () => {
    mockGoogleAuthenticate.mockRejectedValue(
      new Error(JSON.stringify({ status: 401, code: 'INVALID_GOOGLE_CREDENTIAL', message: 'Invalid Google credential' })),
    );
    render(<GoogleSignInButton />);
    await waitFor(() => expect(capturedCallback).toBeTruthy());

    triggerCallback({ credential: 'bad-jwt' });
    await waitFor(() => {
      expect(screen.getByText('Google sign-in failed. Please try again.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Invalid Google credential')).not.toBeInTheDocument();
  });

  it('surfaces a friendly error when no credential is returned (user cancel)', async () => {
    render(<GoogleSignInButton />);
    await waitFor(() => expect(capturedCallback).toBeTruthy());

    triggerCallback({});
    await waitFor(() => {
      expect(screen.getByText('Google sign-in was cancelled')).toBeInTheDocument();
    });
    expect(mockGoogleAuthenticate).not.toHaveBeenCalled();
  });

  it('shows the username input when the server requires a username (USERNAME_REQUIRED)', async () => {
    mockGoogleAuthenticate.mockRejectedValue(
      new Error(JSON.stringify({ status: 422, code: 'USERNAME_REQUIRED', message: 'Please choose a username' })),
    );
    render(<GoogleSignInButton />);
    await waitFor(() => expect(capturedCallback).toBeTruthy());

    triggerCallback({ credential: 'new-user-cred' });
    await waitFor(() => {
      expect(screen.getByPlaceholderText('username')).toBeInTheDocument();
    });
    expect(mockGoogleAuthenticate).toHaveBeenCalledWith({ credential: 'new-user-cred' });
  });

  it('submits the chosen username with the retained credential and succeeds', async () => {
    mockGoogleAuthenticate
      .mockRejectedValueOnce(
        new Error(JSON.stringify({ status: 422, code: 'USERNAME_REQUIRED', message: 'Please choose a username' })),
      )
      .mockResolvedValueOnce(undefined);
    const onSuccess = vi.fn();
    render(<GoogleSignInButton onSuccess={onSuccess} />);
    await waitFor(() => expect(capturedCallback).toBeTruthy());

    triggerCallback({ credential: 'new-user-cred' });
    await waitFor(() => expect(screen.getByPlaceholderText('username')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('username'), 'gamer');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(mockGoogleAuthenticate).toHaveBeenLastCalledWith({ credential: 'new-user-cred', username: 'gamer' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByPlaceholderText('username')).not.toBeInTheDocument();
  });

  it('rejects invalid username format with a validation message', async () => {
    mockGoogleAuthenticate.mockRejectedValue(
      new Error(JSON.stringify({ status: 422, code: 'USERNAME_REQUIRED', message: 'Please choose a username' })),
    );
    render(<GoogleSignInButton />);
    await waitFor(() => expect(capturedCallback).toBeTruthy());

    triggerCallback({ credential: 'new-user-cred' });
    await waitFor(() => expect(screen.getByPlaceholderText('username')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('username'), 'x!x');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Username must be 3-30 characters');
    });
    expect(mockGoogleAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('allows retry with a different username, surfacing a friendly conflict error', async () => {
    mockGoogleAuthenticate
      .mockRejectedValueOnce(
        new Error(JSON.stringify({ status: 422, code: 'USERNAME_REQUIRED', message: 'Please choose a username' })),
      )
      .mockRejectedValueOnce(
        new Error(JSON.stringify({ status: 409, code: 'CONFLICT', message: 'Username already taken' })),
      )
      .mockResolvedValueOnce(undefined);
    const onSuccess = vi.fn();
    render(<GoogleSignInButton onSuccess={onSuccess} />);
    await waitFor(() => expect(capturedCallback).toBeTruthy());

    triggerCallback({ credential: 'new-user-cred' });
    await waitFor(() => expect(screen.getByPlaceholderText('username')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('username'), 'taken_name');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Username already taken');
    });
    expect(mockGoogleAuthenticate).toHaveBeenCalledTimes(2);

    // Retry with a different username.
    const usernameInput = screen.getByPlaceholderText('username');
    await userEvent.clear(usernameInput);
    await userEvent.type(usernameInput, 'new_name');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(mockGoogleAuthenticate).toHaveBeenLastCalledWith({ credential: 'new-user-cred', username: 'new_name' });
  });

  it('shows the existing-account guidance on ACCOUNT_LINK_REQUIRED', async () => {
    mockGoogleAuthenticate.mockRejectedValue(
      new Error(
        JSON.stringify({
          status: 409,
          code: 'ACCOUNT_LINK_REQUIRED',
          message: 'ACCOUNT_LINK_REQUIRED',
        }),
      ),
    );
    render(<GoogleSignInButton />);
    await waitFor(() => expect(capturedCallback).toBeTruthy());

    triggerCallback({ credential: 'linked-email-cred' });
    await waitFor(() => {
      expect(
        screen.getByText('An account already exists for this email. Please sign in with your existing method.'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText('username')).not.toBeInTheDocument();
  });

  it('never renders the username form when the callback succeeds directly', async () => {
    mockGoogleAuthenticate.mockResolvedValue(undefined);
    render(<GoogleSignInButton />);
    await waitFor(() => expect(capturedCallback).toBeTruthy());
    triggerCallback({ credential: 'direct-cred' });
    await waitFor(() => expect(mockGoogleAuthenticate).toHaveBeenCalledTimes(1));
    expect(screen.queryByPlaceholderText('username')).not.toBeInTheDocument();
  });
});