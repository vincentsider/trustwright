// src/ui/App.tsx
//
// The site layout: a sticky nav, the routed page (Outlet), and a shared footer.
// Each section (range, badge, scan, embed) is its own page under src/ui/pages.

import { Outlet, ScrollRestoration, useLocation } from 'react-router-dom';
import { Nav } from './Nav.tsx';

export function App() {
  // The landing page is full-bleed and carries its own footer.
  const isLanding = useLocation().pathname === '/';
  return (
    <>
      <Nav />
      <main>
        <Outlet />
      </main>
      {!isLanding && (
        <footer className="app-foot">
          <div className="app-foot-inner">
            <span>Open source · Apache-2.0 · engineered by{' '}
              <a href="https://deepblocker.ai" target="_blank" rel="noopener noreferrer">DeepBlocker</a>
            </span>
            <a href="https://github.com/vincentsider/trustwright" target="_blank" rel="noopener noreferrer">
              github.com/vincentsider/trustwright
            </a>
          </div>
        </footer>
      )}
      <ScrollRestoration />
    </>
  );
}
