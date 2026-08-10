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

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);