// scripts/prerender.mjs
//
// Post-build static prerender (GEO/SSR). After `vite build` (client) and
// `vite build --ssr src/entry-server.tsx` (SSR bundle), this renders each app
// route to static HTML and injects it into the built index.html's #root, then
// writes one HTML file per route. Cloudflare Assets' html_handling serves
// /<route>/index.html for that path (before the SPA fallback), so a crawler or
// answer engine that never runs JavaScript still receives the real page
// content. The client uses createRoot (not hydrateRoot), so this markup is
// cleanly replaced by the live app on mount — no hydration handshake.
//
// Fully graceful: if the SSR bundle can't load, dist is left exactly as the
// client build produced it (today's SPA shell). If a single route fails to
// render, that route gets a clean empty shell (no wrong content, no crash).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, 'dist');
const ssrEntry = join(root, 'dist-ssr', 'entry-server.js');
const ROOT_RE = /<div id="root">\s*<\/div>/;

function inject(template, html) {
  if (!ROOT_RE.test(template)) throw new Error('prerender: <div id="root"></div> not found in index.html template');
  return template.replace(ROOT_RE, `<div id="root">${html}</div>`);
}

/** dist file path for a route: '/' -> dist/index.html, '/scan' -> dist/scan/index.html. */
function outPathFor(route) {
  if (route === '/') return join(distDir, 'index.html');
  const clean = route.replace(/^\/+|\/+$/g, '');
  return join(distDir, clean, 'index.html');
}

async function main() {
  const template = await readFile(join(distDir, 'index.html'), 'utf8');

  let mod;
  try {
    mod = await import(pathToFileURL(ssrEntry).href);
  } catch (err) {
    console.warn(`[prerender] SSR bundle not loadable, leaving SPA shell as-is: ${err?.message ?? err}`);
    return;
  }
  const { render, PRERENDER_PATHS } = mod;
  if (typeof render !== 'function' || !Array.isArray(PRERENDER_PATHS)) {
    console.warn('[prerender] entry-server did not export render/PRERENDER_PATHS; skipping');
    return;
  }

  let ok = 0;
  let shell = 0;
  for (const route of PRERENDER_PATHS) {
    const out = outPathFor(route);
    await mkdir(dirname(out), { recursive: true });
    try {
      const html = await render(route);
      if (!html || html.length < 32) throw new Error('empty render');
      await writeFile(out, inject(template, html), 'utf8');
      ok++;
      console.log(`[prerender] ✓ ${route} -> ${out.replace(root + '/', '')} (${html.length} bytes)`);
    } catch (err) {
      // Clean empty shell for this route: today's SPA behaviour, never wrong content.
      await writeFile(out, template, 'utf8');
      shell++;
      console.warn(`[prerender] · ${route} kept SPA shell (${err?.message ?? err})`);
    }
  }
  console.log(`[prerender] done: ${ok} prerendered, ${shell} shell-only`);
}

main().catch((err) => {
  // Never fail the build over prerender — the client build is already valid.
  console.warn(`[prerender] skipped due to error: ${err?.message ?? err}`);
});
