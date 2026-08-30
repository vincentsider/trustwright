// src/entry-server.tsx
//
// Build-time prerender entry. `npm run build` builds this to an SSR bundle
// (dist-ssr/entry-server.js); scripts/prerender.mjs then imports it and renders
// each route to static HTML, injecting the markup into the built index.html so
// crawlers and answer engines (GEO) get the real page content without running
// JavaScript. The CLIENT uses createRoot (not hydrateRoot), so this markup is
// plain, hydration-marker-free static HTML that the app cleanly replaces on
// mount — no hydration handshake, no mismatch risk. renderToStaticMarkup + a
// StaticRouter reproduce exactly what the client would show for each URL.

import { renderToStaticMarkup } from 'react-dom/server';
import type { RouteObject } from 'react-router-dom';
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router-dom/server';
import { routes, PRERENDER_PATHS } from './ui/routes.tsx';

export { PRERENDER_PATHS };

/** Render one route to a static HTML string. Throws if the route can't render. */
export async function render(url: string): Promise<string> {
  const { query, dataRoutes } = createStaticHandler(routes);
  const context = await query(new Request('http://localhost' + url));
  if (context instanceof Response) {
    // No loaders/actions redirect in this app; guard defensively so a future one
    // fails the single route (best-effort) rather than corrupting the page.
    throw new Error(`prerender: unexpected Response for ${url}`);
  }
  // dataRoutes is the same routes annotated with ids; the cast bridges react-
  // router's Agnostic* internal type back to RouteObject[] (a known friction
  // under exactOptionalPropertyTypes).
  const router = createStaticRouter(dataRoutes as unknown as RouteObject[], context);
  return renderToStaticMarkup(<StaticRouterProvider router={router} context={context} hydrate={false} />);
}
