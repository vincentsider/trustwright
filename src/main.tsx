// src/main.tsx
//
// App entry + client routing. If no native WebMCP host is present (local dev, or
// a browser without the flag), install the polyfill so the range is still
// runnable. Then mount the router. The Worker serves index.html for every
// unknown path (SPA fallback), so deep links like /badge work on refresh.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { resolveHost } from './webmcp/shim.ts';
import { installPolyfill } from './webmcp/polyfill.ts';
import { routes } from './ui/routes.tsx';
import './ui/theme.css';
import './ui/console.css';

const native = resolveHost();
if (native.source === 'none') installPolyfill();

const router = createBrowserRouter(routes);

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
// createRoot (not hydrateRoot): the build-time prerenderer injects plain static
// markup into #root for crawlers/answer engines; createRoot cleanly replaces it
// with the live app on mount. No hydration handshake, so no mismatch risk.
createRoot(container).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
