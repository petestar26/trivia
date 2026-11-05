import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, Smartphone, X } from 'lucide-react';
import './app-install.css';

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
const dismissalKey = 'salem-install-promo-dismissed-at';
const dismissalDuration = 7 * 24 * 60 * 60 * 1000;
function promoDismissed() {
  try {
    const at = Number(localStorage.getItem(dismissalKey));
    return at > 0 && at <= Date.now() && Date.now() - at < dismissalDuration;
  } catch {
    return false;
  }
}
function standalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function installationGuide(userAgent: string, platform: string, touchPoints: number) {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (platform === 'MacIntel' && touchPoints > 1)) {
    return {
      device: 'iPhone or iPad',
      steps: [
        'Open salem.bet in Safari.',
        'Tap Share. If needed, open the More menu first.',
        'Choose Add to Home Screen, then Add. Leave Open as Web App on if it appears.',
      ],
      help: 'https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios',
    };
  }
  if (/Android/i.test(userAgent))
    return {
      device: 'Android',
      steps: [
        'Open salem.bet in Chrome.',
        'Open the three-dot menu.',
        'Choose Add to Home screen or Install app, then confirm the installation.',
      ],
      help: 'https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid',
    };
  if (
    /Mac/i.test(platform) &&
    /Safari/i.test(userAgent) &&
    !/Chrome|Chromium|Edg|OPR/i.test(userAgent)
  )
    return {
      device: 'Safari on Mac',
      steps: [
        'Open salem.bet in Safari.',
        'Choose File, then Add to Dock.',
        'Select Add. If this option is unavailable, try Chrome or Edge.',
      ],
      help: 'https://support.apple.com/104996',
    };
  return {
    device: 'Computer',
    steps: [
      'Open salem.bet in Chrome or Edge.',
      'Look for the install icon in the address bar.',
      'In Chrome you can also open the menu, choose Cast, save, and share, then Install page as app. Confirm to finish.',
    ],
    help: 'https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DDesktop',
  };
}

type InstallContext = {
  installed: boolean;
  busy: boolean;
  dismissed: boolean;
  install: (opener: HTMLElement) => void;
  help: (opener: HTMLElement) => void;
  dismiss: () => void;
};
const Context = createContext<InstallContext | null>(null);

export function AppInstallProvider({ children }: { children: ReactNode }) {
  const [installed, setInstalled] = useState(standalone);
  const [dismissed, setDismissed] = useState(promoDismissed);
  const [canPrompt, setCanPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const promptRef = useRef<InstallPrompt | null>(null);
  const busyRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const guide = installationGuide(
    navigator.userAgent,
    navigator.platform,
    navigator.maxTouchPoints
  );

  useEffect(() => {
    mounted.current = true;
    const media = window.matchMedia?.('(display-mode: standalone)');
    const completed = () => {
      promptRef.current = null;
      setCanPrompt(false);
      setInstalled(true);
      setOpen(false);
    };
    const changed = () => {
      if (standalone()) completed();
    };
    const offered = (event: Event) => {
      if (standalone() || typeof (event as InstallPrompt).prompt !== 'function') return;
      event.preventDefault();
      promptRef.current = event as InstallPrompt;
      setCanPrompt(true);
      setInstalled(false);
    };
    window.addEventListener('beforeinstallprompt', offered);
    window.addEventListener('appinstalled', completed);
    media?.addEventListener?.('change', changed);
    window.addEventListener('pageshow', changed);
    return () => {
      mounted.current = false;
      window.removeEventListener('beforeinstallprompt', offered);
      window.removeEventListener('appinstalled', completed);
      media?.removeEventListener?.('change', changed);
      window.removeEventListener('pageshow', changed);
    };
  }, []);

  const help = (opener: HTMLElement) => {
    openerRef.current = opener;
    setMessage('');
    setOpen(true);
  };
  const install = async (opener: HTMLElement) => {
    if (busyRef.current || installed) return;
    if (!open) openerRef.current = opener;
    const prompt = promptRef.current;
    if (!prompt) {
      setMessage('');
      setOpen(true);
      return;
    }
    // A browser prompt is single use, and must be invoked from the user's click.
    promptRef.current = null;
    setCanPrompt(false);
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (mounted.current && choice.outcome === 'accepted') setOpen(false);
    } catch {
      if (mounted.current) {
        setMessage('The install prompt could not open. You can use the steps below instead.');
        setOpen(true);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissalKey, String(Date.now()));
    } catch {
      /* Optional preference. */
    }
  };

  return (
    <Context.Provider value={{ installed, busy, dismissed, install, help, dismiss }}>
      {children}
      <Dialog.Root open={open && !installed} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="salem-install-overlay" />
          <Dialog.Content
            className="salem-install-dialog"
            onCloseAutoFocus={(event) => {
              if (openerRef.current?.isConnected) {
                event.preventDefault();
                openerRef.current.focus();
              }
            }}
          >
            <img
              className="salem-install-app-icon"
              src="/icons/icon-192x192.png"
              alt=""
              width="56"
              height="56"
            />
            <Dialog.Title>Install Salem Bet</Dialog.Title>
            <Dialog.Description>
              Keep Salem Bet one tap away on your home screen or desktop.
            </Dialog.Description>
            {message && (
              <p className="salem-install-message" role="status">
                {message}
              </p>
            )}
            {canPrompt && (
              <button
                className="salem-install-primary"
                disabled={busy}
                onClick={(event) => void install(event.currentTarget)}
              >
                <Download size={17} aria-hidden="true" />
                {busy ? 'Opening…' : 'Install now'}
              </button>
            )}
            <p className="salem-install-device">{guide.device}</p>
            <ol>
              {guide.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="salem-install-note">
              You can keep using the website without installing. An internet connection is needed to
              play.
            </p>
            <a
              href={guide.help}
              target="_blank"
              rel="noopener noreferrer"
              className="salem-install-help"
            >
              Browser installation help ↗
            </a>
            <Dialog.Close className="salem-install-close" aria-label="Close installation guide">
              <X size={20} />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Context.Provider>
  );
}

export function InstallAppButton({
  whenReminderHidden = false,
}: { whenReminderHidden?: boolean } = {}) {
  const state = useContext(Context);
  if (!state || state.installed || (whenReminderHidden && !state.dismissed)) return null;
  return (
    <button
      type="button"
      className="salem-install-button"
      disabled={state.busy}
      onClick={(event) => state.install(event.currentTarget)}
    >
      <Download size={16} aria-hidden="true" />
      <span>{state.busy ? 'Opening…' : 'Install app'}</span>
    </button>
  );
}

export function InstallAppCard() {
  const state = useContext(Context);
  if (!state || state.installed || state.dismissed) return null;
  return (
    <aside className="salem-install-card" aria-label="Get the Salem Bet app">
      <span className="salem-install-card-icon" aria-hidden="true">
        <Smartphone size={26} />
      </span>
      <div className="salem-install-copy">
        <strong>Salem Bet, one tap away</strong>
        <p>Add the app to your home screen for easy access.</p>
        <button
          type="button"
          className="salem-install-help"
          onClick={(event) => state.help(event.currentTarget)}
        >
          How to install
        </button>
      </div>
      <button
        type="button"
        className="salem-install-primary"
        disabled={state.busy}
        onClick={(event) => state.install(event.currentTarget)}
      >
        <Download size={16} aria-hidden="true" />
        {state.busy ? 'Opening…' : 'Install app'}
      </button>
      <button
        type="button"
        className="salem-install-dismiss"
        aria-label="Dismiss install reminder"
        onClick={state.dismiss}
      >
        <X size={17} />
      </button>
    </aside>
  );
}
