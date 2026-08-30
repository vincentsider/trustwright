// worker/browserScan.ts
//
// The scan engine, running INSIDE the Worker via Cloudflare Browser Rendering.
// A managed headless Chromium (the `BROWSER` binding) opens the target URL, the
// page's own JavaScript runs, and we read whatever WebMCP host it exposes. No
// separate server to host or scale — Cloudflare runs the browser.
//
// This is still an OBSERVER: it copies declared tool descriptors only, never
// executes a tool, and the caller (worker/scan.ts) re-validates and re-derives
// everything before it signs anything. A scan yields an observation, never a
// credential.

import puppeteer, { type Browser } from '@cloudflare/puppeteer';
import type { Env } from './types.ts';
import { enumerateInPage, normalizeSurface, type NormalTool, type ScanHost } from '../src/scan/enumerate.ts';
import { isBlockedHostname, hostIsPublic } from './netguard.ts';

const WAIT_MS = 8000; // how long the in-page poll waits for a host to appear
const NAV_TIMEOUT_MS = 15000; // navigation ceiling
const HARD_CAP_MS = 25000; // absolute ceiling for the whole scan
const BLOCK = new Set(['image', 'media', 'font']); // heavy subresources we don't need

/**
 * Injected into every scanned page BEFORE its own scripts run. It supplies a
 * standard, spec-shaped WebMCP host (Chrome's imperative `registerTool` +
 * the declarative `provideContext`) at `navigator.modelContext` and
 * `document.modelContext`. Why: a growing number of sites target the native
 * WebMCP API and DON'T ship a polyfill — they assume the browser/agent runtime
 * provides the host. A plain headless Chromium has no such host, so those sites'
 * `registerTool` calls would throw and Trustwright would see zero tools even
 * though the site is perfectly agent-ready. This closes that gap so any site
 * using the standard API is scannable, polyfill or not.
 *
 * It is deliberately NON-DESTRUCTIVE: the property is writable+configurable, so
 * a site that ships its OWN host (by assignment or defineProperty) always wins
 * and replaces ours. The host is tagged with a non-enumerable `__twInjected`
 * marker so the enumerator can tell "the page relied on a host we supplied"
 * (empty ⇒ the page never used WebMCP ⇒ 'none') from "the page installed its
 * own host". It is an OBSERVER shim only: execute() is never invoked by the
 * scanner; only declared descriptors are read.
 *
 * Self-contained (no closure) — it is serialized to source for the browser.
 */
function injectStandardWebmcpHost(): void {
  try {
    const nav = navigator as unknown as { modelContext?: { getTools?: unknown } };
    const doc = document as unknown as { modelContext?: { getTools?: unknown } };
    const already =
      (nav.modelContext && typeof nav.modelContext.getTools === 'function') ||
      (doc.modelContext && typeof doc.modelContext.getTools === 'function');
    if (already) return; // never clobber a real host

    interface Stored {
      tool: { name: string; description?: string; inputSchema?: unknown; annotations?: unknown; execute?: unknown };
      onAbort?: () => void;
      signal?: AbortSignal;
    }
    const tools = new Map<string, Stored>();
    const listeners = new Set<() => void>();
    const emit = (): void => {
      listeners.forEach((l) => {
        try {
          l();
        } catch {
          /* a broken listener must not break registration */
        }
      });
    };
    const toRegistered = (t: Stored['tool']): Record<string, unknown> => {
      const out: Record<string, unknown> = { name: t.name, description: t.description ?? '' };
      if (t.inputSchema) out.inputSchema = t.inputSchema;
      if (t.annotations) out.annotations = t.annotations;
      return out;
    };
    const registerTool = (tool: Stored['tool'], options?: { signal?: AbortSignal }): Promise<void> => {
      if (!tool || typeof tool.name !== 'string') return Promise.resolve();
      const opts = options || {};
      const prev = tools.get(tool.name);
      if (prev && prev.onAbort && prev.signal) prev.signal.removeEventListener('abort', prev.onAbort);
      const stored: Stored = { tool };
      if (opts.signal) {
        const signal = opts.signal;
        if (signal.aborted) {
          emit();
          return Promise.resolve();
        }
        const onAbort = (): void => {
          if (tools.get(tool.name) === stored) {
            tools.delete(tool.name);
            emit();
          }
          signal.removeEventListener('abort', onAbort);
        };
        stored.onAbort = onAbort;
        stored.signal = signal;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      tools.set(tool.name, stored);
      emit();
      return Promise.resolve();
    };
    const provideContext = (ctx?: { tools?: Array<Stored['tool']> }): void => {
      // Declarative API: the given set REPLACES the current one.
      tools.clear();
      const list = (ctx && ctx.tools) || [];
      for (const t of list) if (t && typeof t.name === 'string') tools.set(t.name, { tool: t });
      emit();
    };
    const getTools = (): Promise<Array<Record<string, unknown>>> =>
      Promise.resolve([...tools.values()].map((s) => toRegistered(s.tool)));
    const executeTool = (tool: string | { name?: string }, input?: string): Promise<string | null> => {
      const name = typeof tool === 'string' ? tool : tool && tool.name;
      const stored = name ? tools.get(name) : undefined;
      if (!stored || typeof stored.tool.execute !== 'function') return Promise.resolve(null);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = input ? JSON.parse(input) : {};
      } catch {
        parsed = {};
      }
      return Promise.resolve((stored.tool.execute as (a: unknown, b: unknown) => unknown)(parsed, {})).then((r) => {
        const str = typeof r === 'string' ? r : String(r);
        return str.length > 1500 ? str.slice(0, 1500) : str;
      });
    };

    const host = {
      registerTool,
      provideContext,
      getTools,
      executeTool,
      addEventListener: (type: string, h: () => void): void => {
        if (type === 'toolchange') listeners.add(h);
      },
      removeEventListener: (type: string, h: () => void): void => {
        if (type === 'toolchange') listeners.delete(h);
      },
    };
    Object.defineProperty(host, '__twInjected', { value: true, enumerable: false });

    // Writable + configurable: a page-provided host always wins over ours.
    try {
      Object.defineProperty(nav, 'modelContext', { value: host, writable: true, configurable: true });
    } catch {
      /* ignore */
    }
    try {
      Object.defineProperty(doc, 'modelContext', { value: host, writable: true, configurable: true });
    } catch {
      /* ignore */
    }
  } catch {
    /* never break the page under scan */
  }
}

export interface BrowserScanResult {
  host: ScanHost | 'error';
  tools: NormalTool[];
  error?: string;
}

function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(onTimeout), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(onTimeout);
      },
    );
  });
}

/** Open `url` in the managed browser and return its normalized WebMCP surface. */
export async function scanWithBrowser(env: Env, url: string): Promise<BrowserScanResult> {
  const worker = env.BROWSER;
  if (!worker) return { host: 'error', tools: [], error: 'scan_unavailable' };
  // SSRF layer 2: block a DNS name that resolves to a private address (an
  // internal hostname, or a rebinding record) before spending a browser session.
  let targetHost: string;
  try {
    targetHost = new URL(url).hostname;
  } catch {
    return { host: 'error', tools: [], error: 'invalid_url' };
  }
  if (!(await hostIsPublic(targetHost))) return { host: 'error', tools: [], error: 'blocked_host' };
  // Holder (not a bare `let`) so control-flow analysis keeps the Browser|null type
  // in `finally` even though the handle is assigned inside the launch callback.
  const held: { browser: Browser | null } = { browser: null };
  let abandoned = false;
  try {
    // The deadline now covers launch AND scan (launch was previously unbounded —
    // a stalled launch escaped the ceiling and could orphan a half-open session).
    // If we give up before launch resolves, the .then still reclaims the session
    // the moment it arrives, so nothing leaks on the account's concurrent cap.
    const launchP = puppeteer.launch(worker).then((b) => {
      held.browser = b;
      if (abandoned) void b.close().catch(() => {});
      return b;
    });
    return await withDeadline(
      launchP.then((b) => runScan(b, url)),
      HARD_CAP_MS,
      { host: 'error', tools: [], error: 'scan_timeout' },
    );
  } catch {
    return { host: 'error', tools: [], error: 'scan_failed' };
  } finally {
    // Always release the browser session — leaking one exhausts the account cap.
    abandoned = true;
    try {
      await held.browser?.close();
    } catch {
      /* already gone */
    }
  }
}

/** Never throws: any failure resolves to a host:'error' result. */
async function runScan(browser: Browser, url: string): Promise<BrowserScanResult> {
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    // Supply a standard WebMCP host before the page's scripts run, so a site that
    // uses the native registerTool/provideContext API without shipping its own
    // polyfill is still enumerable. Non-destructive: a page-provided host wins.
    // Best-effort — if this environment lacks evaluateOnNewDocument, we simply
    // fall back to reading whatever host the page provides itself.
    try {
      if (typeof page.evaluateOnNewDocument === 'function') {
        await page.evaluateOnNewDocument(injectStandardWebmcpHost);
      }
    } catch {
      /* injection unavailable — scan proceeds against the page's own host */
    }

    // Drop heavy subresources, and — the SSRF redirect defense — abort any
    // request whose host is internal. A 30x from a public page to a literal
    // private IP is caught synchronously here; a document/frame navigation to a
    // NAME that resolves private is caught by hostIsPublic. Everything else only
    // gets the cheap literal check so a sub-resource can't be redirected inward.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      void (async () => {
        try {
          let host = '';
          try {
            host = new URL(req.url()).hostname;
          } catch {
            /* data:/about:/blob: — no host to police */
          }
          if (host) {
            // resourceType()'s declared union is incomplete; CDP emits
            // 'document' for a top-level/frame navigation at runtime. Compare as
            // a string so a redirect target gets the full async host check.
            const type = String(req.resourceType());
            const isNavigation = type === 'document' || type === 'sub_frame';
            const internal = isNavigation ? !(await hostIsPublic(host)) : isBlockedHostname(host);
            if (internal) return void req.abort();
          }
          if (BLOCK.has(req.resourceType())) return void req.abort();
          void req.continue();
        } catch {
          /* request already handled/torn down */
        }
      })();
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch {
      return { host: 'error', tools: [], error: 'nav_failed' };
    }

    const raw = await page.evaluate(enumerateInPage, WAIT_MS);
    return normalizeSurface(raw);
  } catch {
    return { host: 'error', tools: [], error: 'scan_failed' };
  }
}
