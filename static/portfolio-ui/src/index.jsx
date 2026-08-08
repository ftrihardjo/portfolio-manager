import React from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@forge/bridge';
import './index.css';
import App from './App';

// ── Forge bridge for subtrees that call window.__forgeInvoke ────────
// AutomationRuleBuilder uses window.__forgeInvoke?.(cmd, payload).
// With optional chaining, an unassigned global makes saves/loads
// silently no-op ("✓ Saved" but nothing persisted). Assign it here,
// at module scope, so it exists before any component effect runs.
window.__forgeInvoke = (cmd, payload) => invoke(cmd, payload);

// ── Google tag (gtag.js) ─────────────────────────────────────────────
// Loaded here rather than in index.html because Custom UI's CSP only
// allows scripts explicitly declared in manifest.yml permissions.external —
// see that file for the required entries. Without those, this tag will be
// silently blocked by the CSP (check DevTools console for a
// "Refused to load the script" error if events never appear in GA).
const GA_MEASUREMENT_ID = 'G-9FFJELQ6BR';

const gtagScript = document.createElement('script');
gtagScript.async = true;
gtagScript.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
document.head.appendChild(gtagScript);

window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }
window.gtag = gtag;
gtag('js', new Date());
gtag('config', GA_MEASUREMENT_ID);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);