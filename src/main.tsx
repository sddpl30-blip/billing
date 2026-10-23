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
