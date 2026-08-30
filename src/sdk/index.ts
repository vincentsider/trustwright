// src/sdk/index.ts  (@trustwright/audit)
//
// The self-audit SDK. A WebMCP site imports it and runs a self-audit: it
// enumerates its OWN document.modelContext tools (which it sees perfectly,
// in-context), previews the static checklist locally with the exact same
// analyser Trustwright uses, and submits the surface to the Worker — which
// independently RE-DERIVES the fingerprint + findings before signing, so the
// self-report is never the trust anchor.
//
//   import { audit, requestVerification, confirmVerification } from '@trustwright/audit';
//   await audit({ origin: location.origin });
//
// Reuses src/range so there is zero drift between the local preview and what the
// Worker signs.

import { analyzeSurface, type SurfaceAudit } from '../range/mode2.ts';
import { fingerprintSurface } from '../range/fingerprint.ts';
import type { RegisteredTool } from '../webmcp/types.ts';

const DEFAULT_API = 'https://trustwright.deepblocker.ai';

export interface SdkOptions {
  /** Trustwright API base. Defaults to the hosted Worker. */
  apiBase?: string;
  /** Origin under audit. Defaults to the current page origin. */
  origin?: string;
}

interface Host {
  getTools(options?: { fromOrigins?: string[] }): Promise<RegisteredTool[]>;
}

/** Resolve the page's NATIVE WebMCP host (document/navigator). Null if none. */
export function resolveNativeHost(): Host | null {
  const d = (document as unknown as { modelContext?: { getTools?: unknown } }).modelContext;
  if (d && typeof d.getTools === 'function') return d as Host;
  const n = (navigator as unknown as { modelContext?: { getTools?: unknown } }).modelContext;
  if (n && typeof n.getTools === 'function') return n as Host;
  return null;
}

/** Read the page's current tool surface. Throws if no host is present. */
export async function readSurface(): Promise<RegisteredTool[]> {
  const host = resolveNativeHost();
  if (!host) throw new Error('no WebMCP host on this page');
  return host.getTools();
}

function apiBase(opts: SdkOptions): string {
  return (opts.apiBase ?? DEFAULT_API).replace(/\/$/, '');
}
function originOf(opts: SdkOptions): string {
  return opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
}

/** Run the static checklist locally WITHOUT submitting — a preview for the owner. */
export async function selfAuditPreview(opts: SdkOptions = {}): Promise<SurfaceAudit> {
  const tools = await readSurface();
  return analyzeSurface(tools, { origin: originOf(opts) });
}

export interface AuditResult {
  ok: boolean;
  report?: unknown;
  sha256?: string;
  signature?: string;
  keyId?: string;
  error?: string;
}

/**
 * Submit the surface for a signed audit. Must run ON the audited origin's page
 * (the Worker checks the Origin header) and the origin must be verified first.
 */
export async function audit(opts: SdkOptions = {}): Promise<AuditResult> {
  const tools = await readSurface();
  const origin = originOf(opts);
  try {
    const resp = await fetch(`${apiBase(opts)}/api/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, tools }),
    });
    const body = (await resp.json()) as { report?: unknown; sha256?: string; signature?: string; keyId?: string; error?: string };
    if (!resp.ok) return { ok: false, error: body?.error ?? `http_${resp.status}` };
    return { ok: true, ...body };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** Step 1 of ownership: get a challenge token to place at the well-known path or DNS. */
export async function requestVerification(
  opts: SdkOptions = {},
): Promise<{ ok: boolean; token?: string; instructions?: unknown; error?: string }> {
  try {
    const resp = await fetch(`${apiBase(opts)}/api/verify-origin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: originOf(opts) }),
    });
    const body = (await resp.json()) as { token?: string; instructions?: unknown; error?: string };
    return resp.ok ? { ok: true, ...body } : { ok: false, ...(body?.error ? { error: body.error } : {}) };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** Step 2 of ownership: ask Trustwright to check the placed proof. */
export async function confirmVerification(
  opts: SdkOptions = {},
): Promise<{ ok: boolean; verified: boolean; error?: string }> {
  try {
    const resp = await fetch(`${apiBase(opts)}/api/verify-origin/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: originOf(opts) }),
    });
    const body = (await resp.json()) as { verified?: boolean; error?: string };
    return { ok: resp.ok, verified: body?.verified === true, ...(body?.error ? { error: body.error } : {}) };
  } catch {
    return { ok: false, verified: false, error: 'network' };
  }
}

interface BadgeState {
  state: 'active' | 'revoked' | 'expired' | 'unverified' | 'none';
  fingerprint?: string;
  assuranceScore?: number | null;
  signedAt?: string;
}

/**
 * Publish a signed behaviour manifest (rung 1). Binds the manifest to the current
 * surface fingerprint; Trustwright signs that you MADE these claims. Must run on the
 * audited (verified) origin.
 */
export async function publishManifest(
  manifest: Record<string, unknown>,
  opts: SdkOptions = {},
): Promise<{ ok: boolean; manifestSha256?: string; signature?: string; error?: string }> {
  const fingerprint = await fingerprintSurface(await readSurface());
  try {
    const resp = await fetch(`${apiBase(opts)}/api/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: originOf(opts), fingerprint, manifest }),
    });
    const body = (await resp.json()) as { manifestSha256?: string; signature?: string; error?: string };
    return resp.ok ? { ok: true, ...body } : { ok: false, ...(body?.error ? { error: body.error } : {}) };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** Read the current badge state for an origin (also what the hub's check_badge uses). */
export async function checkBadge(origin: string, opts: SdkOptions = {}): Promise<BadgeState> {
  const resp = await fetch(`${apiBase(opts)}/api/badge?origin=${encodeURIComponent(origin)}`);
  return (await resp.json()) as BadgeState;
}

export type PreflightTrust = 'ok' | 'drifted' | 'revoked' | 'expired' | 'unverified' | 'none' | 'unknown';

export interface PreflightResult {
  trust: PreflightTrust;
  state: BadgeState;
  liveFingerprint?: string;
}

/**
 * Agent-side preflight (item 9): before an agent uses a badged site, fetch the
 * signed fingerprint for the origin and compare it to the tools the agent has
 * ACTUALLY discovered. `ok` = the live surface matches the signed audit;
 * `drifted` = it changed since the audit (do not trust the seal). This is the
 * consumer half of the border check — the hub calls it before granting travel.
 */
export async function preflight(
  origin: string,
  discoveredTools: ReadonlyArray<RegisteredTool>,
  opts: SdkOptions = {},
): Promise<PreflightResult> {
  let state: BadgeState;
  try {
    state = await checkBadge(origin, opts);
  } catch {
    return { trust: 'unknown', state: { state: 'none' } };
  }
  if (state.state !== 'active' || !state.fingerprint) {
    const trust: PreflightTrust =
      state.state === 'revoked' ? 'revoked'
      : state.state === 'expired' ? 'expired'
      : state.state === 'unverified' ? 'unverified'
      : 'none';
    return { trust, state };
  }
  const liveFingerprint = await fingerprintSurface(discoveredTools);
  return { trust: liveFingerprint === state.fingerprint ? 'ok' : 'drifted', state, liveFingerprint };
}

export { probeSurface } from './probe.ts';
export type { LeakFinding } from './probe.ts';
