import { Headphones } from 'lucide-react';
import { useLanguage } from '@/providers/language-provider';
import '@/pages/lounge.css';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useState, useCallback, useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Sidebar } from './sidebar';
import { MobileNavigation } from './mobile-navigation';
import { Header } from './header';
import { useMemberTheme } from '@/components/member/use-member-theme';
import { useAutomaticRewards } from '@/lib/use-automatic-rewards';
import { useAuth } from '@/providers/auth-provider';
import { InstallAppButton, InstallAppCard } from '@/components/app-install';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

import { guestBrowseLocation } from '@/lib/guest-browse-location';
import { GuestAuthProvider } from '@/components/auth/guest-auth-prompt';
import { GuestBrowsePage } from '@/pages/guest-browse';
import '@/pages/guest-browse.css';

export function Layout() {
  const { isAuthenticated, isLoading } = useAuth();
  const { t } = useLanguage();
  const location = useLocation();
  const safeGuestLocation = !isAuthenticated ? guestBrowseLocation(location) : null;
  // An unresolved session is not an anonymous session. Preserve member deep
  // links (including the sportsbook's explicit new-tab launch) until the probe
  // decides. Do not mount private effects or expose a guest action at that URL.
  if (isLoading && safeGuestLocation)
    return (
      <div className="min-h-screen flex items-center justify-center" role="status">
        <span>{t('Loading…')}</span>
      </div>
    );
  if (safeGuestLocation) return <Navigate to={safeGuestLocation} replace />;
  return (
    <GuestAuthProvider signedIn={isAuthenticated}>
      <LayoutContent />
    </GuestAuthProvider>
  );
}

function LayoutContent() {
  const { t: translateUi } = useInterfaceLanguage();

  useMemberTheme();
  const { user, isAuthenticated } = useAuth();
  useAutomaticRewards(user?.id);
  const { t } = useLanguage();
  const { pathname } = useLocation();
  const showSupportShortcut =
    !pathname.startsWith('/support') &&
    !pathname.startsWith('/games/') &&
    !pathname.startsWith('/play-together') &&
    !pathname.startsWith('/messages') &&
    !pathname.startsWith('/casino') &&
    !pathname.startsWith('/sports') &&
    !/^\/groups\/[^/]+/.test(pathname);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The menu button lives in the header, not in a Dialog.Trigger, so Radix cannot
  // return focus to it on close. Remember it and restore focus there ourselves.
  const menuOpener = useRef<HTMLElement | null>(null);
  const openMobileNav = useCallback(() => {
    menuOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMobileNavOpen(true);
  }, []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  useEffect(closeMobileNav, [pathname, closeMobileNav]);
  return (
    <div className="qube-shell min-h-screen" data-guest={!isAuthenticated}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:z-[100] focus:bg-white focus:p-4"
      >
        {translateUi('Skip to content')}
      </a>
      <div className="hidden lg:block">
        <Sidebar />
      </div>
      <Dialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 lg:hidden" />
          <Dialog.Content
            className="fixed inset-y-0 left-0 z-50 w-64 lg:hidden"
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (menuOpener.current?.isConnected) menuOpener.current.focus();
            }}
          >
            <Dialog.Title className="sr-only">{translateUi('Main navigation')}</Dialog.Title>
            <Sidebar onNavigate={closeMobileNav} />
            <Dialog.Close
              className="absolute right-2 top-3 z-[60] min-h-10 min-w-10 rounded-lg bg-white text-gray-700 dark:bg-gray-800 dark:text-white"
              aria-label={translateUi('Close navigation menu')}
            >
              ✕
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="lg:pl-64">
        <Header onMenuClick={openMobileNav} />
        <main id="main-content" className="qube-main p-4 lg:p-8">
          {pathname === '/dashboard' ? <InstallAppCard /> : null}
          {['/dashboard', '/games', '/play-together', '/profile', '/support'].includes(
            pathname
          ) && (
            <div className="salem-member-install">
              <InstallAppButton whenReminderHidden={pathname === '/dashboard'} />
            </div>
          )}
          {/* Guest pages never mount member queries, sockets, or mutation effects. */}
          {isAuthenticated ? <Outlet /> : <GuestBrowsePage />}
        </main>
        {showSupportShortcut && (
          <Link to="/support" className="salem-support-float" aria-label={t('Contact support')}>
            <Headphones size={20} />
          </Link>
        )}
        <MobileNavigation guest={!isAuthenticated} />
      </div>
    </div>
  );
}
