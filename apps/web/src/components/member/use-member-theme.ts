import { useLayoutEffect } from 'react';
import '@/styles/member.css';

/** Include portaled dialogs, and restore the prior theme for staff workspaces. */
export function useMemberTheme(enabled = true) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const hadDark = root.classList.contains('dark');
    root.classList.add('dark', 'qube-member');
    return () => {
      root.classList.remove('qube-member');
      if (!hadDark) root.classList.remove('dark');
    };
  }, [enabled]);
}
