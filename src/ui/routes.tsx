// src/ui/routes.tsx
//
// The single source of truth for the app's routes, shared by the client entry
// (src/main.tsx → createBrowserRouter) and the build-time prerenderer
// (src/entry-server.tsx → createStaticHandler). Keeping ONE routes array means
// the server-rendered HTML and the client router can never drift out of sync.

import type { RouteObject } from 'react-router-dom';
import { App } from './App.tsx';
import { Home } from './pages/Home.tsx';
import { RangePage } from './pages/RangePage.tsx';
import { AuditWizard } from './pages/AuditWizard.tsx';
import { ScanPage } from './pages/ScanPage.tsx';
import { BadgePage } from './pages/BadgePage.tsx';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'range', element: <RangePage /> },
      { path: 'badge', element: <AuditWizard /> },
      { path: 'embed', element: <BadgePage /> },
      { path: 'scan', element: <ScanPage /> },
      { path: '*', element: <Home /> },
    ],
  },
];

/** The concrete paths the prerenderer emits static HTML for (best-effort). */
export const PRERENDER_PATHS = ['/', '/range', '/badge', '/embed', '/scan'];
