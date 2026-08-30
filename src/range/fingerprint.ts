// src/range/fingerprint.ts
//
// The surface fingerprint: a deterministic SHA-256 over a website's WebMCP tool
// set. It is the security anchor of a Mode-2 badge — the signed audit is bound
// to one exact surface, and the live badge recomputes this at use to catch a
// tool-swap or a cloak (honest tools to the auditor, hostile ones to real
// users). It MUST be deterministic across runs and machines, so it does not
// depend on object key order, tool order, or insignificant whitespace.

import type { RegisteredTool } from '../webmcp/types.ts';

/** Canonical per-tool shape that goes into the hash.
 *
 * DELIBERATELY EXCLUDED: anything a HOST stamps onto a tool after registration
 * — `origin`, `title`, `window`, and any other environment decoration. Chrome's
 * native WebMCP host adds these; the polyfill does not. If they entered the
 * hash, the same tools would fingerprint differently per browser, and no badge
 * could ever verify for a native-host visitor (found in the field by customer
 * zero, openclawcity.ai). Only what the SITE declared at registration counts. */
export interface FingerprintTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: unknown;
}

/**
 * Recursively stable-stringify: object keys sorted, array order preserved,
 * primitives as JSON. Deterministic regardless of key insertion order, so the
 * same logical value always serialises to the same bytes.
 */
export function stableStringify(value: unknown, seen?: WeakSet<object>): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  // Circular guard, PATH-SCOPED: a native host can stamp self-referential
  // objects (e.g. a window) into tool structures. We break only true cycles —
  // an object that is its own ancestor — by tracking the current descent path
  // and removing each node on the way back up. A shared sub-object that appears
  // in two SIBLING branches (a DAG, not a cycle) is therefore serialised in
  // full both times, so the hash depends only on structure, never on whether
  // the host happened to share a reference. Mint and verify read the tools
  // independently and may share references differently; path-scoping keeps them
  // identical where a visited-ever set would not.
  const track = seen ?? new WeakSet<object>();
  if (track.has(value as object)) return '"[circular]"';
  track.add(value as object);
  let out: string;
  if (Array.isArray(value)) {
    out = '[' + value.map((v) => stableStringify(v, track)).join(',') + ']';
  } else {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    out = '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k], track)).join(',') + '}';
  }
  track.delete(value as object);
  return out;
}

/** Collapse whitespace runs and trim, so cosmetic spacing does not change the hash. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// --- Canonicalisation caps (parity contract) ------------------------------
//
// These MUST match worker/../scan enumerate.ts's normaliser. The fingerprint is
// computed on TWO independently-read views of the same surface: the mint reads
// the tools through Cloudflare Browser Rendering (which caps them via
// normalizeSurface for storage/analysis), while the live badge reads the RAW
// host.getTools() in the visitor's browser. If those two views hashed
// differently, an honest site's badge would sit permanently on "tools changed"
// (found in the field: the scan path capped annotation/schema content the live
// path left raw). So fingerprintSurface applies the SAME caps itself, to
// whatever it is handed — raw or pre-normalised — and the two always converge.
export const FP_MAX_NAME = 128;
export const FP_MAX_DESC = 8000;
export const FP_MAX_SCHEMA_CHARS = 8000;
export const FP_MAX_ANNOTATION_KEY = 64;
export const FP_MAX_ANNOTATION_STR = 256;

// Tools TRUSTWRIGHT ITSELF injects into every badged page — currently just the
// badge's verify tool that badge.js registers. These EXACT names are excluded
// from the fingerprint so that injecting the verification tool never changes a
// site's hash (which would flip an honest badge to "tools changed") nor shows up
// as "added since audit". They are still ANALYSED for findings. Scoped to exact
// names (NOT a `trustwright_` prefix) so a site is free to name its own tools
// trustwright_* and have them audited normally — the Trustwright site itself
// does (trustwright_scan_site, trustwright_check_badge, …).
export const RESERVED_TOOL_NAMES = new Set<string>(['trustwright_verify_badge']);

function plainObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Host-shape normaliser. A native WebMCP host may hand `inputSchema` (and
 * potentially `annotations`) back as a JSON STRING rather than an object —
 * Chrome's native host serialises `inputSchema` to a string, while the polyfill
 * and the headless scanner keep it an object. If we did not parse it, the schema
 * would be DROPPED on the native host (plainObject rejects a string) but KEPT on
 * the polyfill, so the SAME declared tools would hash differently per browser
 * and an honest badge would flip to "tools changed" for native-host visitors
 * (found in the field by customer zero, openclawcity.ai). Parsing a JSON-object
 * string back to its object makes the fingerprint host-INDEPENDENT. A value that
 * is already an object passes through unchanged (so object-schema tools — the
 * golden vector and every existing mint — hash exactly as before); a non-JSON or
 * non-object string is returned as-is for the caller's plainObject to drop.
 */
function parseHostJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  // Bound the parse of an UNTRUSTED string. /api/scan is public and reads tools
  // from an arbitrary page; without this, a hostile page returning 300 tools ×
  // huge schema strings could pressure the worker isolate with JSON.parse. A
  // string longer than the schema cap would be dropped after parse anyway
  // (JSON.stringify(schema).length > FP_MAX_SCHEMA_CHARS), so skip it up front.
  if (v.length > FP_MAX_SCHEMA_CHARS) return v;
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : v;
  } catch {
    return v;
  }
}

// Schema keys whose VALUES are runtime content, not the tool's input contract:
// a JSON-Schema `enum`/`const` list, or `default`/`examples`. Sites legitimately
// make these DYNAMIC — webmcp.myprovence.fr's `pin_visible_place` has an `enum`
// of the currently-visible place names, which changes every time the map moves,
// so hashing it flipped an honest badge to "tools changed" the moment an agent
// interacted. The CONTRACT (which params exist, their types, which are required)
// is what a swap attack would change, and that is kept — only the volatile value
// lists are dropped, so the fingerprint is stable under benign runtime change.
const VOLATILE_SCHEMA_KEYS = new Set(['enum', 'const', 'default', 'examples']);

function stripVolatileSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatileSchema);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (VOLATILE_SCHEMA_KEYS.has(k)) continue;
      out[k] = stripVolatileSchema(val);
    }
    return out;
  }
  return v;
}

/** Keep only primitive annotation values (drops nested/host junk); cap keys+strings.
 *
 * A `false` boolean hint is DROPPED: for advisory MCP hints (`readOnlyHint`,
 * `untrustedContentHint`, …) `false` is the DEFAULT, semantically identical to
 * the hint being absent. A native host stamps these defaults explicitly where
 * the site declared nothing (Chrome adds `untrustedContentHint:false`), while
 * the polyfill and the raw scanner read omit them — so keeping `false` in the
 * hash made the SAME declared tool fingerprint differently per host and flipped
 * an honest badge to "tools changed" for native-host visitors (customer zero,
 * openclawcity.ai). Only a `true` hint is a positive claim (the read-only lie we
 * detect), so dropping `false` loses no security signal: flipping a hint to
 * `true`, or removing a `true`, still changes the hash. */
function safeAnnotations(v: unknown): Record<string, unknown> | null {
  const o = plainObject(v);
  if (!o) return null;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (k.length > FP_MAX_ANNOTATION_KEY) continue;
    if (val === true) out[k] = true; // false is the default ⇒ dropped (host-independent)
    else if (typeof val === 'number') out[k] = val;
    else if (typeof val === 'string') out[k] = val.slice(0, FP_MAX_ANNOTATION_STR);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Canonicalise ONE tool (raw or already-normalised) to the exact shape that
 * enters the hash, or null to drop it (not an object / no usable name).
 * DELIBERATELY reads only the SITE-DECLARED fields — never a host-stamped
 * origin/title/window — and applies the parity caps above.
 */
export function canonicalizeTool(raw: unknown): FingerprintTool | null {
  const o = plainObject(raw);
  if (!o) return null;
  const name = typeof o.name === 'string' ? o.name.slice(0, FP_MAX_NAME) : '';
  if (!name) return null;
  if (RESERVED_TOOL_NAMES.has(name)) return null; // Trustwright's injected verify tool never enters the hash
  const description = normalizeWhitespace(typeof o.description === 'string' ? o.description.slice(0, FP_MAX_DESC) : '');
  let inputSchema: unknown = null;
  // parseHostJson: a native host may serialise the schema to a JSON string.
  const schema = plainObject(parseHostJson(o.inputSchema));
  if (schema) {
    // Drop volatile value lists (enum/const/default/examples) so a dynamic enum
    // never moves the hash; keep the structural contract.
    const skeleton = stripVolatileSchema(schema);
    try {
      // JSON.stringify also rejects a cyclic schema (throws) — dropped on both
      // sides identically, so a host-stamped cycle can never split the hash.
      if (JSON.stringify(skeleton).length <= FP_MAX_SCHEMA_CHARS) inputSchema = skeleton;
    } catch {
      /* unserialisable / cyclic — drop it */
    }
  }
  // annotations likewise: parse a stringified object so a host that serialises
  // them does not silently drop the readOnly/untrustedContent hints from the hash.
  return { name, description, inputSchema, annotations: safeAnnotations(parseHostJson(o.annotations)) };
}

/** Map tools to the canonical fingerprint shape, dropping unusable entries. */
export function toFingerprintTools(tools: ReadonlyArray<unknown>): FingerprintTool[] {
  const out: FingerprintTool[] = [];
  for (const t of tools) {
    const c = canonicalizeTool(t);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Canonical string form of a surface: tools sorted by name (then by full
 * canonical form as a tiebreak, so even a malformed duplicate-name surface is
 * deterministic), each with stably-ordered nested keys.
 */
export function canonicalSurface(tools: ReadonlyArray<unknown>): string {
  const norm = toFingerprintTools(tools).map((t) => ({ t, s: stableStringify(t) }));
  norm.sort((a, b) => {
    if (a.t.name !== b.t.name) return a.t.name < b.t.name ? -1 : 1;
    return a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
  });
  return '[' + norm.map((x) => x.s).join(',') + ']';
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * SHA-256 fingerprint of a tool surface, as lowercase hex. Deterministic.
 * Throws if Web Crypto is unavailable rather than returning a fake digest — a
 * fingerprint that cannot be trusted must never masquerade as one.
 */
export async function fingerprintSurface(tools: ReadonlyArray<unknown>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto (crypto.subtle) is required to compute a surface fingerprint');
  const canonical = canonicalSurface(tools);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return toHex(digest);
}

/**
 * Per-tool fingerprints (deduplicated, sorted): a SHA-256 over EACH canonical
 * tool. This is what lets the live badge tolerate a legitimately DYNAMIC surface
 * — a site that registers an extra tool at runtime (e.g. one whose options
 * depend on live app state) — without flipping to "tools changed". The badge
 * verifies that every SEALED tool hash is still present in the live set (each
 * audited tool intact, none removed or swapped) and treats any EXTRA live tool
 * as un-audited, not as tampering. Reserved trustwright_ tools are excluded,
 * exactly like the aggregate fingerprint. Sorted + deduped so the array is
 * itself deterministic.
 */
export async function toolFingerprints(tools: ReadonlyArray<unknown>): Promise<string[]> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto (crypto.subtle) is required to compute tool fingerprints');
  const canon = toFingerprintTools(tools).map((t) => stableStringify(t));
  const hashes = await Promise.all(
    canon.map(async (s) => toHex(await subtle.digest('SHA-256', new TextEncoder().encode(s)))),
  );
  return [...new Set(hashes)].sort();
}

// --- Drift sentinel (Bug 2) -----------------------------------------------
//
// The worker (mint + scan) and the browser badge.js both import THIS module,
// so they can only ever disagree if one was built/deployed from a stale tree.
// These three constants are the single source of truth a build-time test AND a
// live worker endpoint (/api/fingerprint-selftest) both assert against. If the
// deployed worker returns anything but FINGERPRINT_GOLDEN_HASH, the two bundles
// have drifted — exactly the silent failure customer zero hit.
//
// Bump FINGERPRINT_ALGO and refresh the golden hash IN THE SAME COMMIT whenever
// you change the canonical form on purpose, then rebuild and redeploy the
// worker and badge.js TOGETHER (`npm run deploy`, never a bare `wrangler deploy`).

/** Canonical-form version. Changes here are deliberate, versioned events.
 *  v3: host-independent hints — a native host serialises `inputSchema` to a JSON
 *  string and stamps default `false` boolean hints (e.g. untrustedContentHint)
 *  the site never declared. v3 parses the string schema back to an object and
 *  drops `false` hints so the same declared tools hash identically whether read
 *  through the native host, the polyfill, or the scanner (customer zero,
 *  openclawcity.ai). Real sites declare no `false` hints, so their existing
 *  seals are unchanged; only the golden vector (which carries an explicit
 *  readOnlyHint:false to exercise the rule) moves. */
export const FINGERPRINT_ALGO = 'sha256/v4-schema-skeleton';

/** A fixed reference surface whose fingerprint is pinned below. */
export const FINGERPRINT_GOLDEN_SURFACE: RegisteredTool[] = [
  {
    name: 'search_articles',
    description: 'Search published articles by keyword.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'post_comment',
    description: 'Post a comment on an article.',
    inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
  },
];

/** Expected fingerprint of FINGERPRINT_GOLDEN_SURFACE under the current algo.
 *  v3 value: post_comment's declared `readOnlyHint:false` is now dropped as the
 *  default, so the pinned hash moved from the v2 e7dc8eab… on the SAME surface. */
export const FINGERPRINT_GOLDEN_HASH = 'e3ebacd342e03dd4b4741011d7277531bcbb67210eac6915e42bde91b4c431eb';
