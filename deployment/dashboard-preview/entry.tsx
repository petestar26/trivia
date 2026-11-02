import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import '@/styles/index.css';
import { WelcomePage, ExplorePage } from '@/pages/welcome';
import { LoginPage } from '@/pages/login';
import { RegisterPage } from '@/pages/register';

function PreviewGate() {
  const location = useLocation();
  const navigate = useNavigate();
  const destination = location.state?.from?.pathname;
  const register = location.pathname === '/register';
  return <>
    <aside className="design-account-controls" aria-label="Account design preview controls">
      <p>ACCOUNT FORM DESIGN · INPUTS DISABLED</p>
      {destination && <p>Selected destination: {destination}</p>}
      <div>
        <button type="button" onClick={()=>navigate('/explore')}>Back to the collection</button>
        <button type="button" onClick={()=>navigate(register?'/login':'/register',{state:location.state})}>{register ? 'View sign-in step' : 'View registration step'}</button>
      </div>
    </aside>
    <fieldset disabled className="design-disabled-account" aria-label="Non-interactive account form design">
      {register ? <RegisterPage /> : <LoginPage />}
    </fieldset>
  </>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<>
  <style>{`
    .design-account-controls{padding:12px 20px;background:#2f1a23;color:#e9c7ac;text-align:center;font:12px/1.6 system-ui}
    .design-account-controls div{display:flex;flex-wrap:wrap;justify-content:center;gap:10px}
    .design-account-controls button{min-height:44px;padding:8px 14px;border:1px solid #bb8c73;border-radius:8px}
    .design-disabled-account{min-width:0;margin:0;padding:0;border:0}
    .pq-auth-shell button[data-design-link]{min-height:44px}
    .design-preview-banner{padding:8px 14px;background:#ebc5a3;color:#2c171b;font:600 10px/1.5 system-ui;text-align:center;letter-spacing:.08em}
    [data-design-link]{cursor:pointer;text-align:inherit}
    .pq-public-header nav button[data-design-link]{display:inline-flex;gap:7px;align-items:center;min-height:44px}
    .pq-public-footer > button[data-design-link]{display:inline-flex;align-items:center;gap:8px;min-height:44px}
    .pq-public button[data-design-link]:focus-visible{outline:2px solid #ecc4a1;outline-offset:5px}
  `}</style>
  <div className="design-preview-banner">INTERACTIVE DESIGN PREVIEW · NO ACCOUNTS OR BACKEND · NO CREDENTIALS COLLECTED</div>
  <MemoryRouter initialEntries={['/']}><Routes>
    <Route path="/" element={<WelcomePage />} />
    <Route path="/explore" element={<ExplorePage />} />
    <Route path="/login" element={<PreviewGate />} />
    <Route path="/register" element={<PreviewGate />} />
    <Route path="*" element={<PreviewGate />} />
  </Routes></MemoryRouter>
</>);
