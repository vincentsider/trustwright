// src/ui/App.tsx
//
// The site layout: a sticky nav, the routed page (Outlet), and a shared footer.
// Each section (range, badge, scan, embed) is its own page under src/ui/pages.

import { Outlet, ScrollRestoration, useLocation } from 'react-router-dom';
import { Nav } from './Nav.tsx';

// Routes that render their OWN footer must NOT also get the shared app-foot, or
// the page shows two footers. Home (the full-bleed landing) carries its own
// `.lp-foot`, and it renders on BOTH '/' and the '*' catch-all — so gating the
// shared footer on `pathname === '/'` left every unknown path with a doubled
// footer. Instead show app-foot ONLY on the concrete sub-routes.
const APP_FOOTER_ROUTES = new Set(['/range', '/badge', '/embed', '/scan', '/report', '/stats']);

export function App() {
  const showAppFooter = APP_FOOTER_ROUTES.has(useLocation().pathname);
  return (
    <>
      <Nav />
      <main>
        <Outlet />
      </main>
      {showAppFooter && (
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
