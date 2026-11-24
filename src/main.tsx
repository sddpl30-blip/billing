// Keep the preferred visual theme before React paints. This never touches financial state.
try { document.documentElement.dataset.mvTheme = localStorage.getItem('mani-vista-ui-theme') === 'ivory' ? 'ivory' : 'emerald'; } catch { /* storage disabled */ }
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { PolicyFooter, PolicyPageView } from './components/PolicyPages';
import { policyForPath } from './policies/content';
import './index.css';

// The policy pages a payment gateway needs open without signing in: they are
// plain text and never start the app, so they work with no session at all.
const baseUrl = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const policy = policyForPath(window.location.pathname, baseUrl);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {policy !== null ? <PolicyPageView page={policy} /> : (<><App /><PolicyFooter /></>)}
  </StrictMode>,
);

// Installable as an app. Only in a production build: in development the
// worker would cache files the dev server is still changing. It never caches
// /api, so an installed app always shows the server's current books.
// The cast is the same as session.ts's: import.meta.env exists under Vite only.
const viteEnv = (import.meta as unknown as { env?: { PROD?: boolean; BASE_URL?: string } }).env;
if (viteEnv?.PROD === true && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${viteEnv.BASE_URL ?? '/'}sw.js`).catch(() => { /* the site works without it */ });
  });
}
