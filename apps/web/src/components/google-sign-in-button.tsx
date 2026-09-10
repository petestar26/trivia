import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { api, googleClientId } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface GoogleSignInButtonProps {
  onSuccess?: () => void;
}

export function GoogleSignInButton({ onSuccess }: GoogleSignInButtonProps) {
  const clientId = googleClientId();
  const { googleAuthenticate } = useAuth();
  const buttonRef = useRef<HTMLDivElement>(null);
  // Credential held ONLY in React memory — never localStorage/sessionStorage
  const credentialRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-step: show username form after USERNAME_REQUIRED
  const [needsUsername, setNeedsUsername] = useState(false);
  const [username, setUsername] = useState('');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const initializedRef = useRef(false);

  // Load GIS script once.
  useEffect(() => {
    if (!clientId || scriptReady) return;
    if (window.google?.accounts?.id) {
      setScriptReady(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => { setScriptReady(true); };
    script.onerror = () => { setError('Google sign-in is temporarily unavailable'); };
    document.head.appendChild(script);
    return () => { script.remove(); };
  }, [clientId, scriptReady]);

  // Initialize GIS and render button once the script is ready.
  useEffect(() => {
    if (!clientId || !buttonRef.current || !scriptReady || initializedRef.current) return;
    if (!window.google?.accounts?.id) return;

    const loadNonceAndInit = async () => {
      try {
        // Fetch fresh nonce from backend through the existing ApiClient, so the
        // request honors API_BASE/API_ORIGIN in the deployed cross-origin
        // VITE_API_URL topology (credentials:include preserved by ApiClient).
        const response = await api.googleNonce();
        if (!response.success || !response.data?.nonce) {
          setError('Google sign-in is temporarily unavailable');
          return;
        }
        const nonce = response.data.nonce;

        window.google!.accounts.id.initialize({
          client_id: clientId,
          nonce,
          use_fedcm_for_button: true,
          callback: async (response: { credential?: string }) => {
            if (!response.credential) {
              setError('Google sign-in was cancelled');
              return;
            }
            credentialRef.current = response.credential;
            setLoading(true);
            setError(null);
            try {
              await googleAuthenticate({ credential: response.credential });
              onSuccess?.();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Google sign-in failed';
              // Parse JSON error for code-specific handling
              let parsed: { code?: string; message?: string } = {};
              try { parsed = JSON.parse(msg); } catch { /* not JSON */ }
              const code = parsed.code || '';
              const message = parsed.message || msg;
              if (code === 'USERNAME_REQUIRED' || message.includes('Please choose a username')) {
                setNeedsUsername(true);
              } else if (code === 'ACCOUNT_LINK_REQUIRED') {
                setError('An account already exists for this email. Please sign in with your existing method.');
              } else {
                setError('Google sign-in failed. Please try again.');
              }
            } finally {
              setLoading(false);
            }
          },
        });

        window.google!.accounts.id.renderButton(buttonRef.current!, {
          type: 'standard',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          width: 300,
        });
        initializedRef.current = true;
      } catch {
        setError('Google sign-in is temporarily unavailable');
      }
    };
    loadNonceAndInit();
  }, [clientId, googleAuthenticate, onSuccess, scriptReady]);

  const handleUsernameSubmit = async () => {
    if (!credentialRef.current) return;
    if (!username.trim() || username.trim().length < 3 || username.trim().length > 30 || !/^[a-zA-Z0-9_]+$/.test(username.trim())) {
      setUsernameError('Username must be 3-30 characters, letters, numbers, and underscores only');
      return;
    }
    setLoading(true);
    setUsernameError(null);
    try {
      await googleAuthenticate({ credential: credentialRef.current, username: username.trim() });
      credentialRef.current = null;
      setNeedsUsername(false);
      onSuccess?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      let parsed: { code?: string; message?: string } = {};
      try { parsed = JSON.parse(msg); } catch { /* not JSON */ }
      const message = parsed.message || msg;
      if (message.includes('Username already taken')) {
        setUsernameError('Username already taken. Please try another.');
      } else {
        setError(message || 'Registration failed');
      }
    } finally {
      setLoading(false);
    }
  };

  if (!clientId) return null;

  if (needsUsername) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-700 dark:text-gray-300 text-center">Choose a username for your new account</p>
        <div className="flex gap-2">
          <Input
            type="text"
            placeholder="username"
            value={username}
            onChange={(e) => { setUsername(e.target.value); setUsernameError(null); }}
            disabled={loading}
            maxLength={30}
          />
          <Button onClick={handleUsernameSubmit} disabled={loading || !username.trim()}>
            {loading ? '...' : 'Continue'}
          </Button>
        </div>
        {usernameError && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{usernameError}</p>}
        <button type="button" className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300" onClick={() => { setNeedsUsername(false); credentialRef.current = null; setUsername(''); setUsernameError(null); }}>
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 text-center" role="alert">{error}</p>
      )}
      <div ref={buttonRef} className="flex justify-center" />
      {loading && <p className="text-sm text-gray-500 text-center">Signing in...</p>}
    </div>
  );
}
