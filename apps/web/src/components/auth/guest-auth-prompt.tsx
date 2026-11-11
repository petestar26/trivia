import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useLocation } from 'react-router-dom';
import { useLanguage } from '@/providers/language-provider';
import { getGuestReturnTo } from '@/lib/guest-return-to';

// Standalone previews/tests can render consumers without creating auth side effects.
const GuestAuthContext = createContext({ requestSignIn: (_reason: string) => {} });
export function useGuestAuth() {
  return useContext(GuestAuthContext);
}

export function GuestAuthProvider({
  children,
  signedIn = false,
}: {
  children: React.ReactNode;
  signedIn?: boolean;
}) {
  const location = useLocation();
  const { t } = useLanguage();
  const currentLocation = useRef(location);
  currentLocation.current = location;
  const originLocation = useRef(location);
  const restoreFocus = useRef(false);
  const [prompt, setPrompt] = useState<{ reason: string; location: typeof location } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const requestSignIn = useCallback(
    (reason: string) => {
      setPrompt((current) => {
        if (current?.location === location) return current;
        restoreFocus.current = false;
        originLocation.current = location;
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return { reason, location };
      });
    },
    [location]
  );

  // Clear even when navigating back to the same URL later. Request/dismiss never navigates.
  useEffect(() => {
    setPrompt(null);
  }, [location]);
  // A prompt opened while a slow session probe was pending is moot once it confirms a member.
  useEffect(() => {
    if (signedIn) setPrompt(null);
  }, [signedIn]);
  const open = prompt !== null && prompt.location === location;
  const from = getGuestReturnTo(location.pathname, location.search);

  return (
    <GuestAuthContext.Provider value={{ requestSignIn }}>
      {children}
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            restoreFocus.current = true;
            setPrompt(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="salem-guest-dialog-overlay" />
          <Dialog.Content
            className="salem-guest-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (
                restoreFocus.current &&
                originLocation.current === currentLocation.current &&
                opener.current?.isConnected
              )
                opener.current.focus();
            }}
          >
            <p className="salem-eyebrow">{t('Join the community')}</p>
            <Dialog.Title>{t('Sign in to continue')}</Dialog.Title>
            <Dialog.Description>
              {t(prompt?.reason || 'Sign in or create an account to use this feature.')}
            </Dialog.Description>
            <p>
              {t('After signing in, you’ll return to browsing. You can choose what to do next.')}
            </p>
            <Dialog.Close
              className="salem-guest-dialog-close"
              aria-label={t('Close sign-in prompt')}
            >
              ×
            </Dialog.Close>
            <div className="salem-guest-actions">
              <Link
                className="salem-button"
                to="/login"
                state={{ from }}
                onClick={() => setPrompt(null)}
              >
                {t('Sign in')}
              </Link>
              <Link
                className="salem-button secondary"
                to="/register"
                state={{ from }}
                onClick={() => setPrompt(null)}
              >
                {t('Create account')}
              </Link>
              <Dialog.Close className="salem-button secondary">{t('Keep browsing')}</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </GuestAuthContext.Provider>
  );
}
