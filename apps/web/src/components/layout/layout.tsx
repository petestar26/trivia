import { Outlet } from 'react-router-dom';
import { useState, useCallback } from 'react';
import { Sidebar } from './sidebar';
import { Header } from './header';

export function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Desktop sidebar (fixed, hidden below lg) */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile drawer overlay */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          aria-modal="true"
          role="dialog"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={closeMobileNav}
            aria-hidden="true"
          />
          {/* Drawer — Sidebar handles its own width; we slide it in */}
          <div className="absolute inset-y-0 left-0 w-64">
            <Sidebar onNavigate={closeMobileNav} />
          </div>
        </div>
      )}

      <div className="lg:pl-64">
        <Header onMenuClick={() => setMobileNavOpen(true)} />
        <main className="p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
