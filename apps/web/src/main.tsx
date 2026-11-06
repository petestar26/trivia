import { LanguageProvider } from '@/providers/language-provider';
import { AppErrorBoundary } from '@/components/app-error-boundary';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { App } from './App';
import { AuthProvider } from '@/providers/auth-provider';
import { SocketProvider } from '@/providers/socket-provider';
import { AppUpdateNotice } from '@/components/app-update-notice';
import { AppInstallProvider } from '@/components/app-install';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      <AppErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AppInstallProvider>
              <AuthProvider>
                <SocketProvider>
                  <App />
                  <AppUpdateNotice />
                  <Toaster />
                </SocketProvider>
              </AuthProvider>
            </AppInstallProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </AppErrorBoundary>
    </LanguageProvider>
  </React.StrictMode>
);
