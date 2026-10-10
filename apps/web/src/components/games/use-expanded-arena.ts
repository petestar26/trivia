import { useLayoutEffect, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** An inline modal view, so expanding never moves or remounts a WebGL canvas. */
export function useExpandedArena(
  expanded: boolean,
  panel: RefObject<HTMLElement>,
  toggle: RefObject<HTMLButtonElement>,
  close: () => void
) {
  useLayoutEffect(() => {
    const element = panel.current;
    if (!expanded || !element) return;
    const previousFocus = document.activeElement;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const bodyStyles = ['position', 'top', 'left', 'width', 'overflow'].map((name) => ({
      name,
      value: document.body.style.getPropertyValue(name),
      priority: document.body.style.getPropertyPriority(name),
    }));
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.position = 'fixed';
    document.body.style.top = `${-scrollY}px`;
    document.body.style.left = `${-scrollX}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    const background = new Map<Element, { inert: string | null; hidden: string | null }>();
    // Isolate siblings at every ancestor level rather than making the app root inert:
    // the mounted arena must remain focusable inside that same root.
    const isolate = () => {
      let current: Element = element;
      while (current.parentElement) {
        const parent = current.parentElement;
        for (const sibling of Array.from(parent.children)) {
          if (sibling === current || background.has(sibling)) continue;
          background.set(sibling, {
            inert: sibling.getAttribute('inert'),
            hidden: sibling.getAttribute('aria-hidden'),
          });
          sibling.setAttribute('inert', '');
          sibling.setAttribute('aria-hidden', 'true');
        }
        if (parent === document.body) break;
        current = parent;
      }
    };
    toggle.current?.focus({ preventScroll: true });
    isolate();
    // Polling can introduce new background controls while the game keeps running.
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(isolate);
    observer?.observe(document.body, { childList: true, subtree: true });

    const focusable = () =>
      Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((candidate) => {
        const style = window.getComputedStyle(candidate);
        return (
          candidate.tabIndex >= 0 &&
          !candidate.closest('[inert], [aria-hidden="true"], [hidden]') &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });
    const focusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target))
        toggle.current?.focus({ preventScroll: true });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') {
        const choices = focusable();
        const first = choices[0] ?? toggle.current;
        const last = choices[choices.length - 1] ?? toggle.current;
        if (
          !element.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus({ preventScroll: true });
        }
      }
    };
    // Older Safari versions without inert still cannot focus or activate hidden controls.
    const blockBackground = (event: Event) => {
      if (event.target instanceof Node && !element.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener('focusin', focusInside, true);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('click', blockBackground, true);
    document.addEventListener('pointerdown', blockBackground, true);

    return () => {
      observer?.disconnect();
      document.removeEventListener('focusin', focusInside, true);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('click', blockBackground, true);
      document.removeEventListener('pointerdown', blockBackground, true);
      for (const [sibling, attributes] of background) {
        if (attributes.inert === null) sibling.removeAttribute('inert');
        else sibling.setAttribute('inert', attributes.inert);
        if (attributes.hidden === null) sibling.removeAttribute('aria-hidden');
        else sibling.setAttribute('aria-hidden', attributes.hidden);
      }
      for (const { name, value, priority } of bodyStyles) {
        if (value) document.body.style.setProperty(name, value, priority);
        else document.body.style.removeProperty(name);
      }
      document.documentElement.style.overflow = htmlOverflow;
      window.scrollTo(scrollX, scrollY);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [expanded, panel, toggle, close]);
}
