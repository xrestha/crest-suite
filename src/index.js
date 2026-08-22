import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { initInstallPrompt } from './utils/installPrompt';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// A focused type=number input treats the mouse wheel as increment/decrement, which
// silently corrupts an entered value when the user scrolls the page to continue.
// Blur it on wheel: the page still scrolls, but the value stays as typed.
document.addEventListener('wheel', () => {
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT' && el.type === 'number') el.blur();
}, { passive: true });

// Service worker: register only in production. In development the dev-server
// bundle has a stable filename, so the SW's cache-first strategy would serve a
// stale bundle forever (old UI "falls back" every reload). In dev we instead
// actively unregister any existing SW and clear its caches.
if ('serviceWorker' in navigator) {
  if (process.env.NODE_ENV === 'production') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    });
  } else {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
    if (window.caches) {
      caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
    }
  }
}

// Chrome fires beforeinstallprompt once and early — before the lazily-loaded Crest Staff portal
// exists to hear it — so it is captured at boot and replayed from the portal's account sheet.
initInstallPrompt();

reportWebVitals();
