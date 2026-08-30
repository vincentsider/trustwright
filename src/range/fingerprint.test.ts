import { describe, it, expect } from 'vitest';
import {
  fingerprintSurface,
  canonicalSurface,
  stableStringify,
  FINGERPRINT_GOLDEN_SURFACE,
  FINGERPRINT_GOLDEN_HASH,
} from './fingerprint.ts';
import { normalizeSurface } from '../scan/enumerate.ts';
import type { RegisteredTool } from '../webmcp/types.ts';

const surface: RegisteredTool[] = [
  {
    name: 'search_docs',
    description: 'Search the docs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_payee',
    description: 'Add a payee.',
    annotations: { readOnlyHint: false },
  },
];

describe('surface fingerprint', () => {
  it('is stable across repeated calls', async () => {
    const a = await fingerprintSurface(surface);
    const b = await fingerprintSurface(surface);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on tool order', async () => {
    const reversed = [...surface].reverse();
    expect(await fingerprintSurface(reversed)).toBe(await fingerprintSurface(surface));
  });

  it('does not depend on object key order within a schema', async () => {
    const reordered: RegisteredTool[] = [
      { ...surface[1]! },
      {
        name: 'search_docs',
        // same schema, keys inserted in a different order
        inputSchema: { required: ['query'], properties: { query: { type: 'string' } }, type: 'object' },
        description: 'Search the docs.',
        annotations: { readOnlyHint: true },
      },
    ];
    expect(await fingerprintSurface(reordered)).toBe(await fingerprintSurface(surface));
  });

  it('ignores cosmetic whitespace in descriptions', async () => {
    const spaced: RegisteredTool[] = [
      surface[0]!,
      { ...surface[1]!, description: '  Add   a   payee.  ' },
    ];
    expect(await fingerprintSurface(spaced)).toBe(await fingerprintSurface(surface));
  });

  it('changes when a description changes', async () => {
    const changed: RegisteredTool[] = [surface[0]!, { ...surface[1]!, description: 'Add a payee silently.' }];
    expect(await fingerprintSurface(changed)).not.toBe(await fingerprintSurface(surface));
  });

  it('changes when an annotation changes (readOnly flipped)', async () => {
    const changed: RegisteredTool[] = [surface[0]!, { ...surface[1]!, annotations: { readOnlyHint: true } }];
    expect(await fingerprintSurface(changed)).not.toBe(await fingerprintSurface(surface));
  });

  it('changes when a tool is added or removed', async () => {
    const base = await fingerprintSurface(surface);
    const added = await fingerprintSurface([...surface, { name: 'z_new', description: 'new' }]);
    expect(added).not.toBe(base);
    expect(await fingerprintSurface([surface[0]!])).not.toBe(base);
  });

  it('an empty surface has a stable fingerprint', async () => {
    expect(await fingerprintSurface([])).toBe(await fingerprintSurface([]));
  });

  it('canonicalSurface is deterministic and sorts by name', () => {
    const c = canonicalSurface(surface);
    expect(c.indexOf('add_payee')).toBeLessThan(c.indexOf('search_docs'));
    expect(canonicalSurface([...surface].reverse())).toBe(c);
  });

  it('stableStringify sorts object keys', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify([3, { y: 1, x: 2 }])).toBe('[3,{"x":2,"y":1}]');
  });
});

// --- Host-invariance: the central Bug-1 guarantee -------------------------
//
// A native WebMCP host (Chrome, once the origin trial shipped) decorates every
// tool it hands back with `origin`, `title`, and even a self-referential
// `window`. The polyfill (Safari, Firefox, headless mint) does not. The badge
// only verifies if the fingerprint computed at MINT (worker, polyfill-ish) and
// the fingerprint computed at VERIFY (visitor's native host) are equal for the
// same declared tools. So host decoration MUST NOT move the hash — otherwise no
// badge could ever read "tools verified" for a Chrome visitor. Caught in the
// field by customer zero, openclawcity.ai.
describe('surface fingerprint — host decoration is invisible', () => {
  // Build a native-host view of the SAME surface: each tool carries the host's
  // stamped origin/title plus a circular back-reference, as Chrome's host does.
  function asNativeHostView(tools: RegisteredTool[]): RegisteredTool[] {
    return tools.map((t) => {
      const decorated = {
        ...t,
        origin: 'https://site.example',
        title: `${t.name} (from https://site.example)`,
      } as RegisteredTool & { window?: unknown };
      // A circular reference, like a stamped window that points back at itself.
      const win: Record<string, unknown> = { self: null };
      win.self = win;
      decorated.window = win;
      return decorated;
    });
  }

  it('the same tools fingerprint identically with or without host stamps', async () => {
    const bare = await fingerprintSurface(surface);
    const native = await fingerprintSurface(asNativeHostView(surface));
    expect(native).toBe(bare);
  });

  it('a stamped origin alone does not change the fingerprint', async () => {
    const withOrigin: RegisteredTool[] = [surface[0]!, { ...surface[1]!, origin: 'https://partner.example' }];
    expect(await fingerprintSurface(withOrigin)).toBe(await fingerprintSurface(surface));
  });

  it('a self-referential (circular) tool does not hang and stays deterministic', async () => {
    const circular = { name: 'loop', description: 'x' } as RegisteredTool & { annotations: unknown };
    const ann: Record<string, unknown> = {};
    ann.back = ann; // annotations point at themselves
    circular.annotations = ann;
    const a = await fingerprintSurface([circular]);
    const b = await fingerprintSurface([circular]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --- Reserved trustwright_ tools are excluded from the fingerprint ---------
//
// badge.js registers a `trustwright_verify_badge` tool on every badged site so
// agents can verify the badge over WebMCP. That tool must NOT change the site's
// fingerprint (or an honest badge would flip to "tools changed"), so the whole
// `trustwright_` namespace is dropped before hashing.
describe('surface fingerprint — reserved trustwright_ tools are excluded', () => {
  it('adding a trustwright_ tool leaves the fingerprint unchanged', async () => {
    const base = [{ name: 'a', description: 'x', annotations: { readOnlyHint: true } }] as RegisteredTool[];
    const withReserved = [
      ...base,
      { name: 'trustwright_verify_badge', description: 'verify', annotations: { readOnlyHint: true } },
    ] as RegisteredTool[];
    expect(await fingerprintSurface(withReserved)).toBe(await fingerprintSurface(base));
  });
});

// --- Shared references (DAG, not a cycle) are structural, not identity -----
//
// The circular guard is PATH-SCOPED: it breaks only an object that is its own
// ancestor. A sub-object referenced by two sibling tools is a DAG, not a cycle,
// and must serialise in full both times — so a surface hashes the same whether
// the host shared one schema object or handed back two equal copies. Mint and
// verify build tool objects independently and may share references differently;
// without path-scoping they could diverge on identical declared tools.
describe('surface fingerprint — shared references hash like duplicated equals', () => {
  it('a shared schema object hashes the same as two equal copies', async () => {
    const shared = { type: 'object', properties: { q: { type: 'string' } } };
    const withSharing: RegisteredTool[] = [
      { name: 'a_tool', description: 'A', inputSchema: shared },
      { name: 'b_tool', description: 'B', inputSchema: shared },
    ];
    const withCopies: RegisteredTool[] = [
      { name: 'a_tool', description: 'A', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'b_tool', description: 'B', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    ];
    expect(await fingerprintSurface(withSharing)).toBe(await fingerprintSurface(withCopies));
  });
});

// --- Mint↔live parity: the scan path caps tools, the live badge reads them raw
//
// The mint fingerprints the surface AFTER normalizeSurface (Browser Rendering,
// for storage/analysis); the live badge fingerprints host.getTools() RAW. If
// fingerprintSurface did not itself canonicalise, any tool the normaliser
// touches (a non-primitive annotation, a >256-char annotation string, a >8000-
// char schema, a >128-char name, a nameless entry) would hash differently on
// the two sides and strand an honest site on "tools changed" forever. This
// asserts the two views always converge — the exact class that hit customer zero.
describe('surface fingerprint — mint (normalized) equals live (raw)', () => {
  async function mintEqualsLive(raw: unknown[]) {
    const live = await fingerprintSurface(raw);
    const minted = await fingerprintSurface(normalizeSurface({ host: 'native', tools: raw }).tools);
    expect(minted).toBe(live);
    return live;
  }

  it('converges for a NON-PRIMITIVE annotation value', async () => {
    await mintEqualsLive([
      { name: 'a', description: 'x', annotations: { readOnlyHint: true, meta: { nested: 'obj' }, tags: [1, 2] } },
    ]);
  });

  it('converges for an OVERSIZED annotation string (>256)', async () => {
    await mintEqualsLive([{ name: 'a', description: 'x', annotations: { note: 'z'.repeat(500) } }]);
  });

  it('converges for an OVERSIZED inputSchema (>8000 chars)', async () => {
    const big = { type: 'object', properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`p${i}`, { type: 'string', description: 'd'.repeat(30) }])) };
    await mintEqualsLive([{ name: 'a', description: 'x', inputSchema: big }]);
  });

  it('converges for a >128-char name and an annotation key >64 chars', async () => {
    await mintEqualsLive([{ name: 'n'.repeat(300), description: 'x', annotations: { ['k'.repeat(100)]: true, ok: 1 } }]);
  });

  it('drops a nameless / non-object entry on both sides', async () => {
    const withJunk: unknown[] = [{ name: 'real', description: 'x' }, { description: 'no name' }, null, 42];
    const clean = [{ name: 'real', description: 'x' }];
    expect(await fingerprintSurface(withJunk)).toBe(await fingerprintSurface(clean));
  });
});

// --- Golden vector: locks the canonical form across BOTH deployed bundles --
//
// The worker (mint + scan) and the browser badge.js both import THIS module.
// Bug 2 was the two deployed artifacts disagreeing on an identical payload
// because they were built from different trees. This pinned hash makes any
// change to the canonical form a loud, intentional test failure — so a stale
// build can never silently ship a fingerprint the other side won't match.
// If you change canonicalisation on purpose, update this value in the same
// commit and rebuild/redeploy the worker AND badge.js together.
describe('surface fingerprint — pinned golden vector (drift sentinel)', () => {
  // Reference surface + pin come from the module itself — the same constants
  // the worker's /api/fingerprint-selftest asserts against — so build-time and
  // run-time verify one source of truth.
  const GOLDEN_SURFACE = FINGERPRINT_GOLDEN_SURFACE;
  const GOLDEN_HASH = FINGERPRINT_GOLDEN_HASH;

  it('the reference surface still hashes to the pinned value', async () => {
    expect(await fingerprintSurface(GOLDEN_SURFACE)).toBe(GOLDEN_HASH);
  });

  it('and a native-host view of it also hashes to the pinned value', async () => {
    const nativeView = GOLDEN_SURFACE.map((t) => {
      const win: Record<string, unknown> = {};
      win.self = win;
      return { ...t, origin: 'https://blog.example', title: t.name, window: win } as RegisteredTool;
    });
    expect(await fingerprintSurface(nativeView)).toBe(GOLDEN_HASH);
  });
});
