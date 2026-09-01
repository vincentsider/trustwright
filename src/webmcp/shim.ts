// src/webmcp/shim.ts
//
// The one place in the codebase that reaches for the live WebMCP host. It
// absorbs the single biggest uncertainty in the build: whether the browser
// exposes the API as `document.modelContext` (Chrome's security docs) or
// `navigator.modelContext` (most third-party writeups), or neither (in which
// case an injected polyfill is used for local dev / non-native browsers).
//
// Because everything else registers tools THROUGH this module, the outcome of
// the day-0 spike (#221) changes one constant here and nothing else.
//
// Memory-safety: every registration returns a disposer. Registrations made via
// `registerAll` are tracked and torn down together by the returned disposer,
// which aborts their controllers AND clears the internal set so nothing is
// retained after teardown.

import type {
  ModelContextHost,
  ModelContextTool,
  RegisterToolOptions,
  HostSource,
} from './types.ts';

interface ResolvedHost {
  host: ModelContextHost | null;
  source: HostSource;
}

/**
 * Resolve the live host without caching a null result: a polyfill may be
 * injected after first paint, so a "none" answer must stay re-checkable.
 */
export function resolveHost(): ResolvedHost {
  if (typeof document !== 'undefined') {
    const d = (document as unknown as { modelContext?: ModelContextHost }).modelContext;
    if (d && typeof d.registerTool === 'function') return { host: d, source: 'document' };
  }
  if (typeof navigator !== 'undefined') {
    const n = (navigator as unknown as { modelContext?: ModelContextHost }).modelContext;
    if (n && typeof n.registerTool === 'function') return { host: n, source: 'navigator' };
  }
  if (typeof globalThis !== 'undefined') {
    const g = (globalThis as unknown as { __webmcpPolyfill?: ModelContextHost }).__webmcpPolyfill;
    if (g && typeof g.registerTool === 'function') return { host: g, source: 'polyfill' };
  }
  return { host: null, source: 'none' };
}

/** True when a usable WebMCP host is present right now. */
export function isWebMcpAvailable(): boolean {
  return resolveHost().host !== null;
}

/** Which host is live, for the diagnostics panel and the spike write-up. */
export function hostSource(): HostSource {
  return resolveHost().source;
}

/** A function that unregisters whatever it was returned for. Idempotent. */
export type Disposer = () => void;

/**
 * Register one tool. Returns a disposer that aborts the registration and
 * releases the controller. If no host is present the tool is a no-op and the
 * disposer is harmless, so callers never need to branch on availability.
 *
 * A caller-supplied `options.signal` is honored: aborting it also unregisters,
 * and the returned disposer is wired to the same controller so there is exactly
 * one teardown path (no double-abort, no leak).
 */
export async function registerTool(
  tool: ModelContextTool,
  options: RegisterToolOptions = {},
): Promise<Disposer> {
  const { host } = resolveHost();
  if (!host) return () => {};
  return registerToolOn(host, tool, options);
}

/**
 * Register one tool against an EXPLICIT host, rather than the resolved global.
 * Same disposer discipline as registerTool. This is the seam that lets a
 * non-browser caller (the server-side gauntlet) drive the exact same level
 * engine against an in-memory host, so the browser and HTTP paths cannot
 * diverge. In the browser, `host` is simply resolveHost().host, so behaviour is
 * identical to before.
 */
export async function registerToolOn(
  host: ModelContextHost,
  tool: ModelContextTool,
  options: RegisterToolOptions = {},
): Promise<Disposer> {
  const controller = new AbortController();
  // If the caller passed their own signal, chain it so either source tears down.
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const registerOptions: RegisterToolOptions = { signal: controller.signal };
  if (options.exposedTo) registerOptions.exposedTo = options.exposedTo;

  try {
    await host.registerTool(tool, registerOptions);
  } catch (err) {
    // A host that rejects registration must not leak the controller.
    controller.abort();
    throw err;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
  };
}

/**
 * Register a batch of tools and return a single disposer that tears all of them
 * down and drops every reference. Use this for a level's tool set so a level
 * cannot outlive itself in memory.
 */
export async function registerAll(
  tools: ModelContextTool[],
  options: RegisterToolOptions = {},
): Promise<Disposer> {
  const { host } = resolveHost();
  if (!host) return () => {};
  return registerAllOn(host, tools, options);
}

/** registerAll against an EXPLICIT host (see registerToolOn). */
export async function registerAllOn(
  host: ModelContextHost,
  tools: ModelContextTool[],
  options: RegisterToolOptions = {},
): Promise<Disposer> {
  let disposers: Disposer[] = await Promise.all(tools.map((t) => registerToolOn(host, t, options)));
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const d of disposers) d();
    disposers = []; // drop references so the closures can be GC'd
  };
}
