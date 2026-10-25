import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/styles/index.css';
import { HomePage } from '@/pages/home';
import { Layout } from '@/components/layout/layout';

const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
ReactDOM.createRoot(document.getElementById('root')!).render(<>
  <style>{`.local-fixture-banner{position:relative;z-index:100;background:#edc4a4;color:#28120e;font:600 11px/24px system-ui;text-align:center;letter-spacing:.1em}.qube-sidebar{top:24px;height:calc(100% - 24px)}.qube-header{top:0}`}</style>
  <div className="local-fixture-banner">OFFLINE PREVIEW · SAMPLE RESULTS & BALANCES · JACKPOT NOT LAUNCHED · NO LIVE CONNECTIONS</div>
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/']}>
      <Routes><Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="*" element={<p>Local UI fixture: navigation destination only.</p>} />
      </Route></Routes>
    </MemoryRouter>
  </QueryClientProvider>
</>);
