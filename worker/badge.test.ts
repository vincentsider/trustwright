import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import worker from './index.ts';
import type { Env, ExecutionContext } from './types.ts';
import { canonicalSurfaceReport, type SurfaceReport } from '../src/range/surfaceReport.ts';
import { hasFailFinding } from './badge.ts';

describe('hasFailFinding', () => {
  it('is true only when a stored finding has verdict FAIL', () => {
    expect(hasFailFinding([{ verdict: 'PASS' }, { verdict: 'FAIL' }])).toBe(true);
    expect(hasFailFinding([{ verdict: 'PASS' }, { verdict: 'PARTIAL' }])).toBe(false);
    expect(hasFailFinding([])).toBe(false);
    expect(hasFailFinding(null)).toBe(false);
    expect(hasFailFinding('not-an-array')).toBe(false);
  });
});

const ctx: ExecutionContext = { waitUntil: () => {}, passThroughOnException: () => {} };

// A real Ed25519 keypair for the signing tests.
let privB64 = '';
let pubB64 = '';
let pubKey: CryptoKey;

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  privB64 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  pubB64 = Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey)).toString('base64');
  pubKey = kp.publicKey;
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ED25519_PRIVATE_KEY: privB64,
    TRUSTWRIGHT_PUBKEY: pubB64,
    TRUSTWRIGHT_KEY_ID: 'k1',
    ADMIN_TOKEN: 'admin-secret',
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

const AUDITED = 'https://site.example';
const tools = [
  { name: 'search_docs', description: 'Search the docs.', annotations: { readOnlyHint: true } },
  { name: 'add_payee', description: 'Add a payee to the account.' },
];

/** Stub the Supabase REST calls; `verified` toggles the origin's state. */
function stubDb(opts: { verified?: boolean; audit?: Record<string, unknown> | null; manifest?: Record<string, unknown> | null } = {}) {
  const verifiedAt = opts.verified ? '2026-08-28T00:00:00Z' : null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/rest/v1/manifests') && method === 'GET') {
        return new Response(JSON.stringify(opts.manifest ? [opts.manifest] : []), { status: 200 });
      }
      if (url.includes('/rest/v1/origins') && method === 'GET') {
        return new Response(JSON.stringify([{ origin: AUDITED, challenge_token: 'tok', verified_at: verifiedAt }]), { status: 200 });
      }
      if (url.includes('/rest/v1/origins') && (method === 'POST' || method === 'PATCH')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/rest/v1/tool_audits') && method === 'POST') {
        return new Response(JSON.stringify([{ id: 'aud-1' }]), { status: 201 });
      }
      if (url.includes('/rest/v1/tool_audits') && method === 'GET') {
        return new Response(JSON.stringify(opts.audit === undefined ? [] : opts.audit ? [opts.audit] : []), { status: 200 });
      }
      if (url.includes('/rest/v1/tool_audits') && method === 'PATCH') {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/rest/v1/manifests') && method === 'POST') {
        return new Response(null, { status: 201 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://api.trustwright.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('Mode 2 — audit + signing', () => {
  it('audits a verified origin, signs the report, and the signature verifies', async () => {
    stubDb({ verified: true });
    const res = await worker.fetch(post('/api/audit', { origin: AUDITED, tools }, { Origin: AUDITED }), env(), ctx);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { report: SurfaceReport; sha256: string; signature: string; keyId: string };
    expect(out.report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(out.report.assuranceScore).toBe(1); // clean surface

    // Verify the Ed25519 signature over the canonical report.
    const canonical = canonicalSurfaceReport(out.report);
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' },
      pubKey,
      Buffer.from(out.signature, 'base64'),
      new TextEncoder().encode(canonical),
    );
    expect(ok).toBe(true);
  });

  it('rejects an audit whose Origin header is not the audited origin (403)', async () => {
    stubDb({ verified: true });
    const res = await worker.fetch(post('/api/audit', { origin: AUDITED, tools }, { Origin: 'https://evil.example' }), env(), ctx);
    expect(res.status).toBe(403);
  });

  it('rejects an audit for an unverified origin (403)', async () => {
    stubDb({ verified: false });
    const res = await worker.fetch(post('/api/audit', { origin: AUDITED, tools }, { Origin: AUDITED }), env(), ctx);
    expect(res.status).toBe(403);
  });

  it('503s when signing is not configured', async () => {
    stubDb({ verified: true });
    const e = env();
    delete (e as { ED25519_PRIVATE_KEY?: string }).ED25519_PRIVATE_KEY;
    const res = await worker.fetch(post('/api/audit', { origin: AUDITED, tools }, { Origin: AUDITED }), e, ctx);
    expect(res.status).toBe(503);
  });

  it('rejects a malformed tool surface (400)', async () => {
    stubDb({ verified: true });
    const res = await worker.fetch(
      post('/api/audit', { origin: AUDITED, tools: [{ name: '' }] }, { Origin: AUDITED }),
      env(),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a tool with an oversized inputSchema (400)', async () => {
    stubDb({ verified: true });
    const huge = { type: 'object', properties: { blob: { type: 'string', enum: Array.from({ length: 2000 }, (_, i) => 'v' + i) } } };
    const res = await worker.fetch(
      post('/api/audit', { origin: AUDITED, tools: [{ name: 'x', description: 'y', inputSchema: huge }] }, { Origin: AUDITED }),
      env(),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe('Mode 2 — manifest elevates the rung', () => {
  const fp = 'a'.repeat(64);
  const auditRow = {
    id: 'aud-1', origin: AUDITED, fingerprint: fp, findings: [], assurance_score: 1, assurance_rung: 0,
    report_sha256: 'b'.repeat(64), signature: 'sig', key_id: 'k1', signed_at: '2026-08-28T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z', revoked_at: null,
  };
  it('badge reports rung 1 when a manifest matches the audited fingerprint', async () => {
    stubDb({ verified: true, audit: auditRow, manifest: { fingerprint: fp, manifest: {}, manifest_sha256: 'c'.repeat(64), signature: 's', key_id: 'k1', signed_at: '2026-08-28T00:00:00Z' } });
    const res = await worker.fetch(new Request(`https://api.trustwright.test/api/badge?origin=${encodeURIComponent(AUDITED)}`), env(), ctx);
    expect(await res.json()).toMatchObject({ state: 'active', assuranceRung: 1 });
  });
  it('a manifest bound to a DIFFERENT fingerprint does not elevate the rung', async () => {
    stubDb({ verified: true, audit: auditRow, manifest: { fingerprint: 'f'.repeat(64), manifest: {}, manifest_sha256: 'c'.repeat(64), signature: 's', key_id: 'k1', signed_at: '2026-08-28T00:00:00Z' } });
    const res = await worker.fetch(new Request(`https://api.trustwright.test/api/badge?origin=${encodeURIComponent(AUDITED)}`), env(), ctx);
    expect(await res.json()).toMatchObject({ state: 'active', assuranceRung: 0 });
  });
});

describe('Mode 2 — badge state', () => {
  it('reports active for a verified origin with a fresh audit', async () => {
    stubDb({
      verified: true,
      audit: {
        id: 'aud-1', origin: AUDITED, fingerprint: 'a'.repeat(64), findings: [], assurance_score: 1,
        assurance_rung: 0, report_sha256: 'b'.repeat(64), signature: 'sig', key_id: 'k1',
        signed_at: '2026-08-28T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', revoked_at: null,
      },
    });
    const res = await worker.fetch(new Request(`https://api.trustwright.test/api/badge?origin=${encodeURIComponent(AUDITED)}`), env(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'active', fingerprint: 'a'.repeat(64) });
  });

  it('reports unverified for an origin that has not proven control', async () => {
    stubDb({ verified: false });
    const res = await worker.fetch(new Request(`https://api.trustwright.test/api/badge?origin=${encodeURIComponent(AUDITED)}`), env(), ctx);
    expect(await res.json()).toMatchObject({ state: 'unverified' });
  });

  it('reports revoked when the latest audit is revoked', async () => {
    stubDb({
      verified: true,
      audit: {
        id: 'aud-1', origin: AUDITED, fingerprint: 'a'.repeat(64), findings: [], assurance_score: 1,
        assurance_rung: 0, report_sha256: 'b'.repeat(64), signature: 'sig', key_id: 'k1',
        signed_at: '2026-08-28T00:00:00Z', expires_at: null, revoked_at: '2026-08-28T01:00:00Z',
      },
    });
    const res = await worker.fetch(new Request(`https://api.trustwright.test/api/badge?origin=${encodeURIComponent(AUDITED)}`), env(), ctx);
    expect(await res.json()).toMatchObject({ state: 'revoked' });
  });
});

describe('Mode 2 — verify-origin + revoke + pubkey', () => {
  /** Count writes (POST/PATCH) the handler issued against the origins table. */
  function originWrites(): number {
    const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit | undefined]> } }).mock
      .calls;
    return calls.filter(
      ([input, init]) =>
        String(input).includes('/rest/v1/origins') && (init?.method === 'POST' || init?.method === 'PATCH'),
    ).length;
  }

  it('issues a challenge token with placement instructions', async () => {
    stubDb();
    const res = await worker.fetch(post('/api/verify-origin', { origin: AUDITED }), env(), ctx);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { token: string; instructions: { wellKnown: { content: string } } };
    expect(out.token).toMatch(/^trustwright-verify-/);
    expect(out.instructions.wellKnown.content).toBe(out.token);
  });

  // SECURITY REGRESSION (2026-09-11 incident): the ownership re-check probes
  // the live site against the STORED token, so a public caller who rotates a
  // verified origin's token gets that origin's badge revoked after the grace
  // window. Anyone could do this to any customer by naming their origin —
  // including an agent innocently calling trustwright_start_verification.
  it('never rotates a verified origin token on a public call', async () => {
    stubDb({ verified: true });
    const res = await worker.fetch(post('/api/verify-origin', { origin: AUDITED }), env(), ctx);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { already_verified?: boolean; token?: string; instructions?: { wellKnown: { content: string } } };
    expect(out.already_verified).toBe(true);
    expect(out.token).toBe('tok'); // the STORED token, so the served proof stays valid
    expect(out.instructions?.wellKnown.content).toBe('tok');
    expect(originWrites()).toBe(0); // nothing written: the stored token is untouched
  });

  it('allows a deliberate admin re-key of a verified origin', async () => {
    stubDb({ verified: true });
    const res = await worker.fetch(
      post('/api/verify-origin', { origin: AUDITED }, { 'x-admin-token': 'admin-secret' }),
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { token: string; already_verified?: boolean };
    expect(out.already_verified).toBeUndefined();
    expect(out.token).toMatch(/^trustwright-verify-/);
    expect(out.token).not.toBe('tok'); // a real rotation
    expect(originWrites()).toBe(1); // exactly the upsert
  });

  it('a wrong admin token does not unlock rotation of a verified origin', async () => {
    stubDb({ verified: true });
    const res = await worker.fetch(
      post('/api/verify-origin', { origin: AUDITED }, { 'x-admin-token': 'wrong' }),
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { already_verified?: boolean; token?: string };
    expect(out.already_verified).toBe(true);
    expect(out.token).toBe('tok');
    expect(originWrites()).toBe(0);
  });

  it('revoke requires the admin token', async () => {
    stubDb();
    const bad = await worker.fetch(post('/api/audit/revoke', { origin: AUDITED }), env(), ctx);
    expect(bad.status).toBe(403);
    const good = await worker.fetch(post('/api/audit/revoke', { origin: AUDITED }, { 'x-admin-token': 'admin-secret' }), env(), ctx);
    expect(good.status).toBe(200);
  });

  it('signs a behaviour manifest for a verified origin (rung 1)', async () => {
    stubDb({ verified: true });
    const fp = 'a'.repeat(64);
    const manifest = { tools: [{ name: 'search_docs', reads: ['query'], sends: [], stores: 'nothing' }] };
    const res = await worker.fetch(
      post('/api/manifest', { origin: AUDITED, fingerprint: fp, manifest }, { Origin: AUDITED }),
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { manifestSha256: string; signature: string };
    expect(out.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.signature.length).toBeGreaterThan(0);
  });

  it('rejects a manifest for an unverified origin (403)', async () => {
    stubDb({ verified: false });
    const res = await worker.fetch(
      post('/api/manifest', { origin: AUDITED, fingerprint: 'a'.repeat(64), manifest: {} }, { Origin: AUDITED }),
      env(),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it('serves the public key', async () => {
    const res = await worker.fetch(new Request('https://api.trustwright.test/api/pubkey'), env(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alg: 'Ed25519', keyId: 'k1', publicKey: pubB64 });
  });

  it('preflights a Mode-2 endpoint with reflected CORS', async () => {
    const res = await worker.fetch(
      new Request('https://api.trustwright.test/api/audit', { method: 'OPTIONS', headers: { Origin: 'https://any.example' } }),
      env(),
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://any.example');
  });
});
