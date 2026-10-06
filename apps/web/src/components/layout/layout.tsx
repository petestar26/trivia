import { Outlet } from 'react-router-dom';
import { useState, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Sidebar } from './sidebar';
import { Header } from './header';
import { useMemberTheme } from '@/components/member/use-member-theme';

export function Layout() {
  useMemberTheme();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  return (
    <div className="qube-shell min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:z-[100] focus:bg-white focus:p-4"
      >
        Skip to content
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
          >
            <Dialog.Title className="sr-only">Main navigation</Dialog.Title>
            <Sidebar onNavigate={closeMobileNav} />
            <Dialog.Close
              className="absolute right-2 top-3 z-[60] min-h-10 min-w-10 rounded-lg bg-white text-gray-700 dark:bg-gray-800 dark:text-white"
              aria-label="Close navigation menu"
            >
              ✕
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="lg:pl-64">
        <Header onMenuClick={() => setMobileNavOpen(true)} />
        <main id="main-content" className="qube-main p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
