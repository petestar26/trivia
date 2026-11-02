/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    nonce?: string;
    use_fedcm_for_button?: boolean;
    button_auto_select?: boolean;
    auto_select?: boolean;
    callback: (response: { credential?: string }) => void;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: string;
      size?: string;
      text?: string;
      theme?: string;
      shape?: string;
      width?: number;
    }
  ): void;
  prompt(): void;
}

interface GoogleAccounts {
  id: GoogleAccountsId;
}

declare global {
  interface Window {
    google?: {
      accounts: GoogleAccounts;
    };
  }
}

export {};
