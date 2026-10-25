import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import '@/styles/index.css';
import { WelcomePage, ExplorePage } from '@/pages/welcome';

function PreviewGate() {
  const location = useLocation();
  const navigate = useNavigate();
  const destination = location.state?.from?.pathname;
  const register = location.pathname === '/register';
  return <main className="pq-public" style={{padding:'60px 24px',textAlign:'center'}}>
    <p className="pq-public-eyebrow">DESIGN PREVIEW · NO ACCOUNT ACCESS</p>
    <h1>{register ? 'Create your account.' : 'Sign in to join.'}</h1>
    <p style={{color:'#c7b4a9',lineHeight:1.8,margin:'20px auto',maxWidth:470}}>
      This is where the application opens its protected {register ? 'registration' : 'sign-in'} page.
      This design preview collects no credentials and does not create an account or join a game.
    </p>
    {destination && <p style={{marginBottom:24}}>Selected destination: {destination}</p>}
    <button type="button" className="pq-public-primary" onClick={()=>navigate('/explore')}>Back to the collection</button>
    <button type="button" className="pq-public-account" style={{display:'block',margin:'20px auto',minHeight:44,padding:'10px 18px'}} onClick={()=>navigate(register?'/login':'/register',{state:location.state})}>{register ? 'View sign-in step' : 'View registration step'}</button>
  </main>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<>
  <style>{`
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
