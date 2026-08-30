// src/badge/embed.ts
//
// The live, self-verifying Trustwright badge. A site embeds:
//
//   <script src="https://trustwright.deepblocker.ai/badge.js" data-origin="https://site.com"></script>
//
// It runs ON the site's page (same-origin execution, so it can read the page's
// actual WebMCP tools), fetches the signed badge state, recomputes the surface
// fingerprint from the tools present RIGHT NOW, and renders a verdict in a shadow
// DOM. A tool-swap or cloak shows "tools changed", never a green seal. It never
// verifies against a dev polyfill — only a native host counts as a live check.
//
// Presentation + placement are customisable via data-attributes, but the
// VERDICT is not:
//   data-theme   "light" (default) | "dark" | "auto" (follow prefers-color-scheme)
//   data-variant "default" (dot + label + sub) | "compact" (dot + label only)
//   data-mount   CSS selector of an element to render INTO (default: right after
//                this <script>). Use it to place the badge inside a full-screen
//                app's own chrome — e.g. a fixed corner div.
// The tone/label always come from decideBadge, so a site can restyle or reposition
// the badge but can never make it claim more than the signed, live-checked state.

import { fingerprintSurface, toolFingerprints } from '../range/fingerprint.ts';
import {
  decideBadgeLive,
  displayWithGraceLive,
  type BadgeDisplay,
  type BadgeStateJson,
  type LiveCheck,
  type Tone,
} from './decide.ts';
import type { RegisteredTool } from '../webmcp/types.ts';

// Capture the script element synchronously — document.currentScript is null after
// the first await. Fall back to finding our own tag by src, so frameworks that
// inject the script dynamically (next/script, etc.) still resolve the API origin
// and options instead of mistaking the host page for the API.
const scriptEl =
  (document.currentScript as HTMLScriptElement | null) ??
  (document.querySelector('script[src*="/badge.js"]') as HTMLScriptElement | null);

const TONE_COLOR: Record<Tone, string> = {
  ok: '#0891b2',
  warn: '#b45309',
  bad: '#be123c',
  neutral: '#475569',
};

function nativeHost(): { getTools(): Promise<RegisteredTool[]> } | null {
  const d = (document as unknown as { modelContext?: { getTools?: unknown } }).modelContext;
  if (d && typeof d.getTools === 'function') return d as { getTools(): Promise<RegisteredTool[]> };
  const n = (navigator as unknown as { modelContext?: { getTools?: unknown } }).modelContext;
  if (n && typeof n.getTools === 'function') return n as { getTools(): Promise<RegisteredTool[]> };
  return null;
}

type Theme = 'light' | 'dark' | 'auto';

function themeVars(theme: Theme): string {
  // Palette pairs: [background, primary text, muted sub, border-alpha].
  const light = '--tw-bg:#fff;--tw-fg:#0a0e1a;--tw-sub:#64748b';
  const dark = '--tw-bg:#0d121c;--tw-fg:#f2f6fc;--tw-sub:#94a3b8';
  if (theme === 'dark') return `:host{${dark}}`;
  if (theme === 'auto') return `:host{${light}}@media (prefers-color-scheme:dark){:host{${dark}}}`;
  return `:host{${light}}`;
}

/**
 * Where to mount the badge. By default it inserts right after the <script> tag
 * (so on a normal page it lands where you paste the line). With data-mount="<css
 * selector>" it renders INTO the element you name instead — the way to place it
 * inside a full-screen app's own HTML chrome (a fixed corner, a nav bar, a
 * panel). The selector is the owner's own attribute; we querySelector it and
 * append a node — never inject it as HTML.
 */
function waitForElement(sel: string, timeoutMs: number): Promise<Element | null> {
  let first: Element | null = null;
  try {
    first = document.querySelector(sel);
  } catch {
    return Promise.resolve(null); // invalid selector
  }
  if (first) return Promise.resolve(first);
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const iv = setInterval(() => {
      const el = document.querySelector(sel);
      if (el || Date.now() > deadline) {
        clearInterval(iv);
        resolve(el);
      }
    }, 200);
  });
}

async function resolveMount(): Promise<{ parent: Node; before: Node | null }> {
  const sel = scriptEl?.dataset.mount;
  if (sel) {
    const el = await waitForElement(sel, 6000);
    if (el) return { parent: el, before: null };
  }
  return { parent: scriptEl?.parentNode ?? document.body, before: scriptEl?.nextSibling ?? null };
}

/** A live badge with an in-place updater, so an async host can upgrade the verdict. */
type BadgePainter = (d: BadgeDisplay) => void;

function styleFor(theme: Theme, color: string): string {
  return (
    themeVars(theme) +
    '.tw{display:inline-flex;align-items:center;gap:8px;font:500 12px/1.2 ui-sans-serif,system-ui,sans-serif;' +
    'text-decoration:none;border:1px solid ' + color + '33;border-radius:8px;padding:6px 10px;' +
    'background:var(--tw-bg);color:var(--tw-fg)}' +
    '.dot{width:8px;height:8px;border-radius:50%;background:' + color + ';flex:none}' +
    '.lab{color:' + color + ';font-weight:600}.sub{color:var(--tw-sub);font-weight:400}'
  );
}

function render(
  target: { parent: Node; before: Node | null },
  apiBase: string,
  origin: string,
  initial: BadgeDisplay,
  opts: { theme: Theme; compact: boolean },
): BadgePainter {
  const mount = document.createElement('span');
  target.parent.insertBefore(mount, target.before);
  const shadow = mount.attachShadow({ mode: 'open' });
  // Link to the human-readable audit report (what was checked + how to verify),
  // NOT the raw JSON API — that is what builds trust when someone clicks a badge.
  const href = `${apiBase}/report?origin=${encodeURIComponent(origin)}`;
  const styleEl = document.createElement('style');
  const a = document.createElement('a');
  a.className = 'tw';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const lab = document.createElement('span');
  lab.className = 'lab';
  const sb = document.createElement('span');
  sb.className = 'sub';
  a.append(dot, lab);
  shadow.append(styleEl, a);

  // Only controlled strings reach the DOM: label/sub come from decideBadge, the
  // color from a fixed map, the href is URL-encoded. The raw origin is never
  // injected as HTML. paint() can be called again to upgrade the verdict in place.
  const paint: BadgePainter = (d) => {
    styleEl.textContent = styleFor(opts.theme, TONE_COLOR[d.tone]);
    lab.textContent = 'Trustwright: ' + d.label;
    if (!opts.compact && d.sub) {
      sb.textContent = d.sub;
      if (!sb.isConnected) a.append(sb);
    } else if (sb.isConnected) {
      sb.remove();
    }
  };
  paint(initial);
  return paint;
}

async function run(): Promise<void> {
  const origin = scriptEl?.dataset.origin;
  if (!origin) return;
  const apiBase = scriptEl?.dataset.api || (scriptEl?.src ? new URL(scriptEl.src).origin : location.origin);

  let state: BadgeStateJson;
  try {
    const resp = await fetch(`${apiBase}/api/badge?origin=${encodeURIComponent(origin)}`);
    if (!resp.ok) return;
    state = (await resp.json()) as BadgeStateJson;
  } catch {
    return;
  }

  const themeAttr = scriptEl?.dataset.theme;
  const theme: Theme = themeAttr === 'dark' || themeAttr === 'auto' ? themeAttr : 'light';
  const compact = scriptEl?.dataset.variant === 'compact';

  const host0 = nativeHost();
  const live0: LiveCheck = host0 ? await readLiveCheck(host0, state) : { host: false };

  const target = await resolveMount();
  const paint = render(target, apiBase, origin, displayWithGraceLive(state, live0, false), { theme, compact });

  // Make the badge machine-verifiable on EVERY badged site: register a WebMCP
  // tool an agent can call to get the signed verdict + how to check it. Named in
  // the reserved `trustwright_` namespace, so it is excluded from the fingerprint
  // and never affects the verdict. The tool recomputes the live verdict at CALL
  // time, so it is always accurate regardless of when the agent asks.
  const registered = { done: false };
  if (host0) registered.done = registerVerifyTool(host0, origin, apiBase, state);

  // Reconcile against the live host, which (with its tools) often arrives a tick
  // after badge.js runs. Two jobs, either of which may still be pending:
  //   (a) register trustwright_verify_badge as soon as ANY host appears — for
  //       EVERY badge state, so even a revoked/expired/unverified badge stays
  //       agent-checkable (not just the active case);
  //   (b) for an active badge, upgrade the verdict to the live "tools verified"
  //       once the audited tools are all present (else it sits on the weaker
  //       "tools audited" — the race first seen on deepblocker.ai).
  // Bounded + self-terminating: stops when no work remains or the grace window
  // closes. No persistent timer, no listener — nothing to leak. A "match" here is
  // the SUBSET verdict (every sealed tool present, extras tolerated), so a
  // dynamic site that adds a tool still resolves to verified, not "changed".
  const isVerified = (l: LiveCheck): boolean => l.host && (l.exact || l.sealedPresent);
  const matched0 = state.state === 'active' && isVerified(live0);
  if (!registered.done || (state.state === 'active' && !matched0)) {
    const started = Date.now();
    const WINDOW_MS = 6000;
    const STEP_MS = 250;
    const tick = async (): Promise<void> => {
      const host = nativeHost();
      if (host && !registered.done) registered.done = registerVerifyTool(host, origin, apiBase, state);
      const graceExpired = Date.now() - started >= WINDOW_MS;
      let matched = false;
      if (state.state === 'active') {
        const live: LiveCheck = host ? await readLiveCheck(host, state) : { host: false };
        paint(displayWithGraceLive(state, live, graceExpired));
        matched = isVerified(live);
      }
      const workLeft = !registered.done || (state.state === 'active' && !matched);
      if (graceExpired || !workLeft) return; // done
      setTimeout(() => void tick(), STEP_MS);
    };
    setTimeout(() => void tick(), STEP_MS);
  }
}

/**
 * Read the page's live tools and compare to the SEALED surface. Returns a
 * subset-aware LiveCheck: `exact` (whole surface hashes to the seal) and
 * `sealedPresent` (every sealed per-tool hash still present — audited tools
 * intact, `extras` = count of added-since-audit tools). Falls back to exact
 * aggregate match for a pre-0007 seal with no per-tool hashes. A read failure
 * resolves to `{host:false}` (show the signed state, not an alarm).
 */
async function readLiveCheck(
  host: { getTools(): Promise<RegisteredTool[]> },
  state: BadgeStateJson,
): Promise<LiveCheck> {
  try {
    const tools = await host.getTools();
    const sealedFp = (state as { fingerprint?: string }).fingerprint;
    const exact = (await fingerprintSurface(tools)) === sealedFp;
    const sealed = (state as { toolFingerprints?: string[] | null }).toolFingerprints;
    if (!sealed || sealed.length === 0) return { host: true, exact, sealedPresent: exact, extras: 0 };
    const liveHashes = await toolFingerprints(tools);
    const liveSet = new Set(liveHashes);
    const sealedSet = new Set(sealed);
    const sealedPresent = sealed.every((h) => liveSet.has(h));
    const extras = liveHashes.reduce((n, h) => (sealedSet.has(h) ? n : n + 1), 0);
    return { host: true, exact, sealedPresent, extras };
  } catch {
    return { host: false };
  }
}

type RegisterableHost = { registerTool?: (tool: unknown, options?: unknown) => unknown };

/**
 * Register `trustwright_verify_badge` on the page's WebMCP host. Its execute()
 * recomputes the LIVE verdict at call time (re-reads the host's current tools
 * and re-runs decideBadge), so an agent always gets the honest current answer —
 * "tools verified", "tools changed", or "tools audited" — no matter when it
 * asks. Returns true if the registration was accepted. Best-effort: a host with
 * no usable registerTool just returns false and the visual badge still renders.
 */
function registerVerifyTool(
  host: { getTools(): Promise<RegisteredTool[]> } | null,
  origin: string,
  apiBase: string,
  state: BadgeStateJson,
): boolean {
  const reg = (host as RegisterableHost | null)?.registerTool;
  if (typeof reg !== 'function') return false;
  // One registration per page: a site can mount several badge surfaces (each
  // its own script instance), but the tool is page-global, and a second
  // register of the same name is what native hosts reject.
  const w = window as Window & { __twVerifyToolRegistered?: boolean };
  if (w.__twVerifyToolRegistered) return true;
  const s = state as { assuranceScore?: number | null; fingerprint?: string; signedAt?: string };
  const staticInfo = {
    badge: 'Trustwright — trust layer for the WebMCP agent web',
    issuer: new URL(apiBase).host,
    subject: origin,
    status: state.state,
    assurance_score: typeof s.assuranceScore === 'number' ? s.assuranceScore : null,
    audited_tool_fingerprint: s.fingerprint ?? null,
    signed_at: s.signedAt ?? null,
    what_it_certifies:
      'Trustwright independently read the WebMCP tools this site exposes to AI agents, tested them for known tool-surface attacks (hidden instructions, false read-only, cross-origin relay, and more), and signed the result with Ed25519. The badge re-checks the live tools on every load and is revocable if they change.',
    verify: {
      live_state: `${apiBase}/api/badge?origin=${encodeURIComponent(origin)}`,
      public_report: `${apiBase}/report?origin=${encodeURIComponent(origin)}`,
      report_json: `${apiBase}/api/report?origin=${encodeURIComponent(origin)}`,
      issuer_public_key: `${apiBase}/api/pubkey`,
      signature_algorithm: 'Ed25519',
    },
  };
  const execute = async (): Promise<string> => {
    // Recompute against the tools present RIGHT NOW — the honest current verdict,
    // subset-aware (audited tools intact, extras tolerated).
    const h = nativeHost();
    const live: LiveCheck = h ? await readLiveCheck(h, state) : { host: false };
    const d = decideBadgeLive(state, live);
    return JSON.stringify(
      {
        ...staticInfo,
        verdict: d.label,
        detail: d.sub,
        audited_tools_intact: live.host ? live.exact || live.sealedPresent : null,
        tools_added_since_audit: live.host ? live.extras : null,
      },
      null,
      2,
    );
  };
  try {
    // Chrome's NATIVE registerTool returns a promise that can reject
    // asynchronously; the try only covers a sync throw, so an unabsorbed
    // rejection surfaces as an unhandledrejection on the HOST page
    // (Sentry d100a902, openclawcity.ai, 30 Aug).
    void Promise.resolve(
      reg.call(host, {
        name: 'trustwright_verify_badge',
        description:
          "Return this site's Trustwright verification badge: what it certifies about the site's agent tools, the live verdict right now, and how to check it independently.",
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        execute,
      }),
    ).catch(() => {});
    w.__twVerifyToolRegistered = true;
    return true;
  } catch {
    return false; // host rejected the registration — the badge still renders
  }
}

// Parity self-test hook (Bug 2). ONLY when the embed is loaded with an explicit
// data-selftest="1" — never on a real badge embed — expose the fingerprint fn so
// a post-deploy check can prove THIS deployed badge.js agrees with the worker on
// the golden surface. Guarded this tightly, it adds nothing to a customer page
// and never fetches or renders. Real embeds fall through to run().
if (scriptEl?.dataset.selftest === '1') {
  (window as unknown as { __trustwrightFingerprint?: typeof fingerprintSurface }).__trustwrightFingerprint =
    fingerprintSurface;
} else {
  void run();
}
