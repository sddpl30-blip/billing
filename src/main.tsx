// Keep the preferred visual theme before React paints. This never touches financial state.
try { document.documentElement.dataset.mvTheme = localStorage.getItem('mani-vista-ui-theme') === 'ivory' ? 'ivory' : 'emerald'; } catch { /* storage disabled */ }
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
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
