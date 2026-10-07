import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// webOS can mount before the document is fully sized; waiting for the DOM keeps
// the fixed 1920x1080 surface from being measured as 0x0, which would break the
// grid scroll math on the very first render.
function mount() {
  const container = document.getElementById('root');
  if (!container) return;

  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
