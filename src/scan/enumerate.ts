// src/scan/enumerate.ts
//
// Two pure, testable pieces of a headless scan, shared by the Worker's
// Browser-Rendering scan (worker/browserScan.ts):
//
//   enumerateInPage  — runs INSIDE the target page (serialized to the browser).
//                      Finds a WebMCP host and reads its raw tool descriptors.
//   normalizeSurface — runs in the Worker on the raw result: coerces + caps
//                      every field so a hostile page cannot return something
//                      huge or weird. The Worker then re-validates strictly.
//
// Neither piece trusts the page: descriptors are DATA. We copy only the declared
// fields (name/description/inputSchema/annotations), never execute a tool, and
// never keep a function reference.

export const MAX_TOOLS = 300;
export const MAX_NAME = 128;
export const MAX_DESC = 8000;
export const MAX_SCHEMA_CHARS = 8000;

export type ScanHost = 'native' | 'polyfill' | 'none';

export interface RawScan {
  host: ScanHost;
  tools: unknown[];
}

export interface NormalTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Executed in the page context. Polls for a WebMCP host for up to `waitMs`,
 * then returns the raw tool list. Must be self-contained (no closure over
 * module scope) because it is serialized to a string for the browser.
 *
 * The scanner may INJECT a standard, spec-shaped WebMCP host before the page's
 * scripts run (worker/browserScan.ts), so a site that uses the native
 * `navigator.modelContext.registerTool` / `provideContext` API but ships no
 * host of its own is still enumerable. That injected host carries a
 * non-enumerable `__twInjected` marker. It exists from t=0, so — unlike a
 * page-provided host — an EMPTY injected host is not proof of anything yet: the
 * page may register tools asynchronously. We therefore treat the two cases
 * differently:
 *   - page-provided host  → report exactly what it has right now (unchanged).
 *   - our injected host    → wait for tools to appear and settle; if none ever
 *                            do, the page never used WebMCP → report 'none'.
 */
export async function enumerateInPage(waitMs: number): Promise<RawScan> {
  const deadline = Date.now() + waitMs;
  type Host = { getTools?: (o?: unknown) => unknown; __twInjected?: unknown };
  const find = (): { host: Host; kind: 'native' | 'polyfill'; injected: boolean } | null => {
    const w = window as unknown as {
      __webmcpPolyfill?: unknown;
      navigator: { modelContext?: Host };
      document: { modelContext?: Host };
    };
    const doc = w.document?.modelContext;
    const nav = w.navigator?.modelContext;
    const host = (doc && typeof doc.getTools === 'function' && doc) || (nav && typeof nav.getTools === 'function' && nav) || null;
    if (!host) return null;
    // Heuristic only; the Worker treats native and polyfill identically.
    const kind = w.__webmcpPolyfill ? 'polyfill' : 'native';
    return { host, kind, injected: host.__twInjected === true };
  };
  const readTools = async (host: Host): Promise<unknown[]> => {
    try {
      const t = await Promise.resolve(host.getTools!());
      return Array.isArray(t) ? t : [];
    } catch {
      return [];
    }
  };
  const sleep = () => new Promise((r) => setTimeout(r, 150));

  for (;;) {
    const f = find();
    if (f) {
      const tools = await readTools(f.host);
      if (!f.injected) {
        // A host the PAGE installed: report what it declares right now (the
        // long-standing behaviour). An empty page-host is a real "host, no
        // tools" result, not a missing surface.
        return { host: f.kind, tools };
      }
      // Our injected host. Tools arrive asynchronously as the page's scripts run.
      if (tools.length > 0) {
        // Let a burst of registrations settle: return once the count is stable
        // across one interval (or the deadline is reached).
        let stable = tools;
        while (Date.now() < deadline) {
          await sleep();
          const next = await readTools(f.host);
          if (next.length === stable.length) break;
          stable = next;
        }
        return { host: f.kind, tools: stable };
      }
      // Empty injected host at the deadline ⇒ the page never used WebMCP.
      if (Date.now() >= deadline) return { host: 'none', tools: [] };
    } else if (Date.now() >= deadline) {
      return { host: 'none', tools: [] };
    }
    await sleep();
  }
}

function plainObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Keep only boolean/string/number annotation values (drops nested junk). */
function safeAnnotations(v: unknown): Record<string, unknown> | undefined {
  const o = plainObject(v);
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (k.length > 64) continue;
    if (typeof val === 'boolean' || typeof val === 'number') out[k] = val;
    else if (typeof val === 'string') out[k] = val.slice(0, 256);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Coerce and cap a raw scan into a clean surface. Faithful (no silent tool
 * dropping) but bounded: an entry that is not an object, or has no usable name,
 * is skipped rather than allowed to corrupt the whole surface.
 */
export function normalizeSurface(raw: RawScan): { host: ScanHost; tools: NormalTool[] } {
  if (raw.host === 'none') return { host: 'none', tools: [] };
  const tools: NormalTool[] = [];
  for (const item of raw.tools.slice(0, MAX_TOOLS)) {
    const o = plainObject(item);
    if (!o) continue;
    const name = typeof o.name === 'string' ? o.name.slice(0, MAX_NAME) : '';
    if (!name) continue;
    const description = typeof o.description === 'string' ? o.description.slice(0, MAX_DESC) : '';
    const tool: NormalTool = { name, description };
    const schema = plainObject(o.inputSchema);
    if (schema) {
      try {
        if (JSON.stringify(schema).length <= MAX_SCHEMA_CHARS) tool.inputSchema = schema;
      } catch {
        /* unserialisable — drop it */
      }
    }
    const ann = safeAnnotations(o.annotations);
    if (ann) tool.annotations = ann;
    tools.push(tool);
  }
  return { host: raw.host, tools };
}
