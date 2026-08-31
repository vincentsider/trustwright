import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { runBadgeMonitor, isDrift } from './monitor.ts';
import type { Env } from './types.ts';

// The browser scan and the (crypto-backed) fingerprint helpers are mocked so the
// monitor's LOGIC is what's under test, not Cloudflare Browser Rendering. The
// convention: each scanned tool carries its per-tool hash in `description`, so
// the mocked fingerprint fns derive deterministic values that survive
// validateTools (which keeps name + description).
vi.mock('./browserScan.ts', () => ({ scanWithBrowser: vi.fn() }));
vi.mock('../src/range/fingerprint.ts', () => ({
  fingerprintSurface: vi.fn(async (tools: Array<{ description?: string }>) =>
    'agg:' + tools.map((t) => t.description ?? '').sort().join(','),
  ),
  toolFingerprints: vi.fn(async (tools: Array<{ description?: string }>) =>
    [...new Set(tools.map((t) => t.description ?? ''))].sort(),
  ),
}));
vi.mock('./email.ts', () => ({
  isAlertConfigured: vi.fn(() => true),
  sendBadgeAlertEmail: vi.fn(async () => true),
}));

import { scanWithBrowser } from './browserScan.ts';
import { sendBadgeAlertEmail, isAlertConfigured } from './email.ts';

const NOW = Date.parse('2026-08-31T12:00:00Z');
const DAY = 86_400_000;

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    BROWSER: {} as Env['BROWSER'],
    POSTMARK_SERVER_API_KEY: 'pm-token',
    ALERT_EMAIL: 'ops@example.com',
    ...overrides,
  } as Env;
}

interface AuditRow {
  id: string;
  origin: string;
  fingerprint: string;
  tool_fingerprints: string[] | null;
  expires_at: string | null;
  last_checked_at: string | null;
  drift_detected_at: string | null;
}

interface PatchCall {
  id: string;
  body: Record<string, unknown>;
}

/** Stub Supabase: GET returns the audit batch; PATCH records the health update. */
function stubDb(rows: AuditRow[]) {
  const patches: PatchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/rest/v1/tool_audits') && method === 'GET') {
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      if (url.includes('/rest/v1/tool_audits') && method === 'PATCH') {
        const m = /id=eq\.([^&]+)/.exec(url);
        patches.push({
          id: decodeURIComponent(m?.[1] ?? ''),
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return { patches };
}

/** Point the mocked scanner at a per-origin surface (tool descriptions = hashes). */
function stubScan(byOrigin: Record<string, { host: string; descriptions?: string[]; error?: string }>) {
  (scanWithBrowser as unknown as Mock).mockImplementation(async (_env: Env, urlOrOrigin: string) => {
    const origin = new URL(urlOrOrigin).origin;
    const f = byOrigin[origin] ?? { host: 'error', error: 'not_configured' };
    const tools = (f.descriptions ?? []).map((d, i) => ({ name: `tool_${i}`, description: d }));
    return { host: f.host, tools, error: f.error };
  });
}

/** The alert payload from the most recent sendBadgeAlertEmail call. */
function lastAlert(): { subject: string; lines: string[]; intro?: string } {
  const calls = (sendBadgeAlertEmail as unknown as Mock).mock.calls;
  return calls[calls.length - 1]?.[1] as { subject: string; lines: string[]; intro?: string };
}

function auditRow(over: Partial<AuditRow> & Pick<AuditRow, 'origin'>): AuditRow {
  return {
    id: `id-${over.origin}`,
    fingerprint: 'agg:t1,t2',
    tool_fingerprints: ['t1', 't2'],
    expires_at: new Date(NOW + 60 * DAY).toISOString(),
    last_checked_at: new Date(NOW - DAY).toISOString(),
    drift_detected_at: null,
    ...over,
  };
}

beforeEach(() => {
  (scanWithBrowser as unknown as Mock).mockReset();
  (sendBadgeAlertEmail as unknown as Mock).mockClear();
  (isAlertConfigured as unknown as Mock).mockReturnValue(true);
});
afterEach(() => vi.unstubAllGlobals());

describe('isDrift (pure subset rule)', () => {
  const sealed = { fingerprint: 'agg:t1,t2', toolFingerprints: ['t1', 't2'] };
  it('exact aggregate match is never drift', () => {
    expect(isDrift(sealed, { fingerprint: 'agg:t1,t2', toolFingerprints: ['t1', 't2'] })).toBe(false);
  });
  it('an added tool (superset) is not drift', () => {
    expect(isDrift(sealed, { fingerprint: 'agg:t1,t2,t3', toolFingerprints: ['t1', 't2', 't3'] })).toBe(false);
  });
  it('a removed/altered sealed tool IS drift', () => {
    expect(isDrift(sealed, { fingerprint: 'agg:t1,t9', toolFingerprints: ['t1', 't9'] })).toBe(true);
  });
  it('pre-0007 audits (no per-tool hashes) fall back to exact match', () => {
    const legacy = { fingerprint: 'agg:t1,t2', toolFingerprints: null };
    expect(isDrift(legacy, { fingerprint: 'agg:t1,t2', toolFingerprints: ['t1', 't2'] })).toBe(false);
    expect(isDrift(legacy, { fingerprint: 'agg:t1,t2,t3', toolFingerprints: ['t1', 't2', 't3'] })).toBe(true);
  });
});

describe('runBadgeMonitor', () => {
  it('is a no-op without a BROWSER binding', async () => {
    const { patches } = stubDb([auditRow({ origin: 'https://a.example' })]);
    const s = await runBadgeMonitor(makeEnv({ BROWSER: undefined }), NOW);
    expect(s.skipped).toBe('no_browser_binding');
    expect(s.checked).toBe(0);
    expect(patches).toHaveLength(0);
  });

  it('records a healthy check and does not alert', async () => {
    const { patches } = stubDb([auditRow({ origin: 'https://ok.example' })]);
    stubScan({ 'https://ok.example': { host: 'native', descriptions: ['t1', 't2'] } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 1, ok: 1, drift: 0, newDrift: 0 });
    expect(patches[0]?.body).toMatchObject({ last_live_fingerprint: 'agg:t1,t2', drift_detected_at: null });
    expect(sendBadgeAlertEmail).not.toHaveBeenCalled();
  });

  it('tolerates an added tool without flagging drift', async () => {
    stubDb([auditRow({ origin: 'https://dyn.example' })]);
    stubScan({ 'https://dyn.example': { host: 'native', descriptions: ['t1', 't2', 't3'] } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 1, ok: 1, drift: 0 });
  });

  it('detects new drift, records onset, and emails once', async () => {
    const { patches } = stubDb([auditRow({ origin: 'https://drift.example' })]);
    stubScan({ 'https://drift.example': { host: 'native', descriptions: ['t1', 't9'] } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 1, drift: 1, newDrift: 1, emailed: true });
    expect((patches[0]?.body ?? {}).drift_detected_at).toBe(new Date(NOW).toISOString());
    expect(sendBadgeAlertEmail).toHaveBeenCalledTimes(1);
    const alert = lastAlert();
    expect(alert.subject).toContain('1 changed');
    expect(alert.lines[0]).toContain('https://drift.example');
  });

  it('does not re-alert an already-drifted badge (preserves onset)', async () => {
    const onset = new Date(NOW - 2 * DAY).toISOString();
    const { patches } = stubDb([auditRow({ origin: 'https://still.example', drift_detected_at: onset })]);
    stubScan({ 'https://still.example': { host: 'native', descriptions: ['t1', 't9'] } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 1, drift: 1, newDrift: 0 });
    expect((patches[0]?.body ?? {}).drift_detected_at).toBe(onset); // unchanged
    expect(sendBadgeAlertEmail).not.toHaveBeenCalled();
  });

  it('clears the flag and alerts on recovery', async () => {
    const onset = new Date(NOW - 2 * DAY).toISOString();
    const { patches } = stubDb([auditRow({ origin: 'https://back.example', drift_detected_at: onset })]);
    stubScan({ 'https://back.example': { host: 'native', descriptions: ['t1', 't2'] } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 1, ok: 1, recovered: 1, emailed: true });
    expect((patches[0]?.body ?? {}).drift_detected_at).toBeNull();
    const alert = lastAlert();
    expect(alert.subject).toContain('1 recovered');
  });

  it('never flips drift on an unreachable origin, and leaves the flag untouched', async () => {
    const onset = new Date(NOW - 2 * DAY).toISOString();
    const { patches } = stubDb([auditRow({ origin: 'https://down.example', drift_detected_at: onset })]);
    stubScan({ 'https://down.example': { host: 'error', error: 'scan_timeout' } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 1, unreachable: 1, newDrift: 0, recovered: 0 });
    // Only last_checked_at is written — drift flag and live fp are left as-is.
    expect(patches[0]?.body).toEqual({ last_checked_at: new Date(NOW).toISOString() });
    expect(sendBadgeAlertEmail).not.toHaveBeenCalled();
  });

  it('treats a vanished WebMCP host as unreachable, not drift', async () => {
    stubDb([auditRow({ origin: 'https://nohost.example' })]);
    stubScan({ 'https://nohost.example': { host: 'none' } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 1, unreachable: 1, drift: 0, newDrift: 0 });
  });

  it('warns once when a badge first enters the expiry window', async () => {
    // Expires in 5 days (< 7-day window); the previous check predates the window
    // opening (here: never checked) -> this run crosses in -> one warning.
    stubDb([
      auditRow({
        origin: 'https://exp.example',
        expires_at: new Date(NOW + 5 * DAY).toISOString(),
        last_checked_at: null,
      }),
    ]);
    stubScan({ 'https://exp.example': { host: 'native', descriptions: ['t1', 't2'] } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 1, ok: 1, expiringSoon: 1, emailed: true });
    const alert = lastAlert();
    expect(alert.subject).toContain('1 expiring');
  });

  it('does not re-warn expiry when the previous check was already in the window', async () => {
    // Previous check yesterday, expiry in 3 days: yesterday (in 4 days to expiry)
    // was already inside the 7-day window -> no fresh transition.
    stubDb([
      auditRow({
        origin: 'https://exp2.example',
        expires_at: new Date(NOW + 3 * DAY).toISOString(),
        last_checked_at: new Date(NOW - DAY).toISOString(),
      }),
    ]);
    stubScan({ 'https://exp2.example': { host: 'native', descriptions: ['t1', 't2'] } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 1, expiringSoon: 0 });
    expect(sendBadgeAlertEmail).not.toHaveBeenCalled();
  });

  it('skips an already-expired audit (needs a re-mint, not a scan)', async () => {
    const { patches } = stubDb([auditRow({ origin: 'https://old.example', expires_at: new Date(NOW - DAY).toISOString() })]);
    stubScan({ 'https://old.example': { host: 'native', descriptions: ['t1', 't2'] } });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s.checked).toBe(1);
    expect(s.ok).toBe(0);
    expect(patches).toHaveLength(0); // never scanned, never patched
    expect(scanWithBrowser).not.toHaveBeenCalled();
  });

  it('does not email when alerting is not configured', async () => {
    (isAlertConfigured as unknown as Mock).mockReturnValue(false);
    stubDb([auditRow({ origin: 'https://drift.example' })]);
    stubScan({ 'https://drift.example': { host: 'native', descriptions: ['t1', 't9'] } });
    const s = await runBadgeMonitor(makeEnv({ POSTMARK_SERVER_API_KEY: undefined }), NOW);
    expect(s).toMatchObject({ newDrift: 1, emailed: false });
    expect(sendBadgeAlertEmail).not.toHaveBeenCalled();
  });

  it('processes a mixed batch correctly', async () => {
    stubDb([
      auditRow({ origin: 'https://ok.example' }),
      auditRow({ origin: 'https://drift.example' }),
      auditRow({ origin: 'https://down.example' }),
    ]);
    stubScan({
      'https://ok.example': { host: 'native', descriptions: ['t1', 't2'] },
      'https://drift.example': { host: 'native', descriptions: ['t1', 't9'] },
      'https://down.example': { host: 'error', error: 'scan_failed' },
    });
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 3, ok: 1, drift: 1, newDrift: 1, unreachable: 1, emailed: true });
  });

  it('is a clean no-op when there are no active badges', async () => {
    const { patches } = stubDb([]);
    const s = await runBadgeMonitor(makeEnv(), NOW);
    expect(s).toMatchObject({ checked: 0, ok: 0, drift: 0, emailed: false });
    expect(patches).toHaveLength(0);
  });
});
