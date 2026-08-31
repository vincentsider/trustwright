// src/data/api.ts
//
// Browser-side client for the Trustwright Worker. Persistence is OPTIONAL: if no
// Worker origin is configured (local dev, or a build without the var), every
// call degrades to a harmless no-op and the range still runs end to end. This
// mirrors SimplyDash's "degrade gracefully" pattern — the demo is never one
// backend outage away from being dead.
//
// The browser holds no Supabase or detector key; it only talks to the Worker.

import type { Scorecard, LevelResult } from '../range/scoring.ts';

// Empty string => same-origin (Worker serves the SPA). Undefined var => no
// backend configured => persistence disabled.
const ORIGIN: string | undefined = import.meta.env.VITE_WORKER_ORIGIN;

/** Whether a backend is configured at all. */
export function persistenceEnabled(): boolean {
  return ORIGIN !== undefined;
}

function apiUrl(path: string): string {
  const base = (ORIGIN ?? '').replace(/\/$/, '');
  return `${base}${path}`;
}

async function postJson(path: string, body: unknown): Promise<unknown | null> {
  if (!persistenceEnabled()) return null;
  try {
    const resp = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null; // persistence must never break the run
  }
}

/** Persist a completed scorecard. Returns its server id, or null if not saved. */
export async function saveScorecard(
  scorecard: Scorecard,
  agentLabel: string,
  corpusVersion: string,
): Promise<string | null> {
  const body = {
    agent_label: agentLabel,
    corpus_version: corpusVersion,
    decided: scorecard.decided,
    resisted: scorecard.resisted,
    partial: scorecard.partial,
    fell: scorecard.fell,
    resistance_score: scorecard.resistanceScore,
    results: scorecard.results.map((r: LevelResult) => ({
      levelId: r.levelId,
      category: r.category,
      verdict: r.verdict,
      ...(r.evidence ? { evidence: r.evidence } : {}),
    })),
  };
  const out = (await postJson('/api/scorecard', body)) as { id?: string } | null;
  return out?.id ?? null;
}

export interface LeaderboardEntry {
  agent_label: string;
  resistance_score: number | null;
  resisted: number;
  decided: number;
  created_at: string;
}

/** Fetch the leaderboard. Returns [] when persistence is off or on error. */
export async function getLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
  if (!persistenceEnabled()) return [];
  try {
    const resp = await fetch(apiUrl(`/api/leaderboard?limit=${limit}`));
    if (!resp.ok) return [];
    const out = (await resp.json()) as { rows?: LeaderboardEntry[] };
    return out.rows ?? [];
  } catch {
    return [];
  }
}

export interface DetectorVerdict {
  status: 'ok' | 'warming' | 'unavailable';
  band?: 'REAL' | 'UNCERTAIN' | 'FAKE';
  fakeProbability?: number | null;
}

/**
 * Send a bundled audio clip to the Worker's detector proxy and return the
 * verdict. Used by level T7 to run DeepBlocker's real deepfake detector on a
 * caller's voice. Bounded by an AbortController so a cold detector never stalls
 * the run — the caller falls back to the clip's known verdict on timeout/null.
 */
export async function verifyBundledClip(
  clipPath: string,
  timeoutMs = 8000,
): Promise<DetectorVerdict | null> {
  if (!persistenceEnabled()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const clip = await fetch(clipPath, { signal: controller.signal });
    if (!clip.ok) return null;
    const blob = await clip.blob();
    const form = new FormData();
    form.append('audio', blob, 'caller.webm');
    const resp = await fetch(apiUrl('/api/verify-audio'), {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) {
      // 429/503 (rate-limited / daily cap) => treat as unavailable, fall back.
      return { status: 'unavailable' };
    }
    return (await resp.json()) as DetectorVerdict;
  } catch {
    return null; // aborted or offline; caller falls back
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch PREMIUM attack specs for an entitlement token. Returns [] on any failure
 * (no token, not entitled, offline) so the range always runs on the public
 * corpus — premium is purely additive. The caller validates every spec with the
 * bundled validateSpec before running it, so nothing here is trusted blindly.
 */
export async function fetchPremiumCorpus(token: string): Promise<unknown[]> {
  if (!token) return [];
  try {
    const resp = await fetch(mode2Url('/api/corpus?tier=premium'), { headers: { 'x-corpus-token': token } });
    if (!resp.ok) return [];
    const out = (await resp.json()) as { specs?: unknown[] };
    return Array.isArray(out.specs) ? out.specs : [];
  } catch {
    return [];
  }
}

// ── Mode 2: audit a site's tools + badge ─────────────────────────────────────
//
// These talk to the same Worker. Unlike persistence, Mode 2 is the product, so
// these surface errors to the caller instead of silently no-opping.

/** Base for direct (non-degrading) Mode 2 calls: same-origin when unset. */
function mode2Url(path: string): string {
  const base = (ORIGIN ?? '').replace(/\/$/, '');
  return `${base}${path}`;
}

async function mode2Post<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const resp = await fetch(mode2Url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data: T | null = null;
    try {
      data = (await resp.json()) as T;
    } catch {
      data = null;
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export interface VerifyInstructions {
  wellKnown: { path: string; content: string };
  dns: { record: string; type: string; value: string };
}

/** Step 1: request an ownership challenge token for an origin. */
export function requestVerification(origin: string) {
  return mode2Post<{ origin: string; token: string; instructions: VerifyInstructions; error?: string }>(
    '/api/verify-origin',
    { origin },
  );
}

/** Step 2: ask Trustwright to fetch the proof and mark the origin verified. */
export function confirmVerification(origin: string) {
  return mode2Post<{ origin: string; verified: boolean; error?: string }>('/api/verify-origin/confirm', { origin });
}

export interface ScanFinding {
  toolName: string | null; // null for surface-level findings (e.g. T3 tool-set change)
  check: string;
  verdict: 'PASS' | 'PARTIAL' | 'FAIL';
  layer: string;
  evidence?: string;
}

export interface ScanResult {
  url: string;
  origin: string;
  host: 'native' | 'polyfill' | 'none';
  tools: number;
  fingerprint?: string;
  findings: ScanFinding[];
  assuranceScore?: number;
  signed: boolean;
  scannedAt: string;
  note: string;
}

/** Scan any URL (unsigned preview). */
export function scanUrl(url: string) {
  return mode2Post<ScanResult & { error?: string }>('/api/scan', { url });
}

export interface MintedBadge {
  origin: string;
  sha256: string;
  signature: string;
  keyId: string;
  expiresAt: string;
  report?: { fingerprint?: string; findings?: ScanFinding[]; assuranceScore?: number | null };
  error?: string;
}

/** Self-serve: mint a signed badge for an origin the caller has verified. */
export function createBadge(url: string) {
  return mode2Post<MintedBadge>('/api/audit/self', { url });
}

export interface BadgeState {
  origin: string;
  state: 'active' | 'revoked' | 'expired' | 'unverified' | 'none';
  fingerprint?: string;
  assuranceScore?: number | null;
  assuranceRung?: number;
  flagged?: boolean; // active audit recorded a confirmed FAIL
  signedAt?: string;
}

/** Read the current live badge state for an origin. */
export async function checkBadge(origin: string): Promise<BadgeState | null> {
  try {
    const resp = await fetch(mode2Url(`/api/badge?origin=${encodeURIComponent(origin)}`));
    if (!resp.ok) return null;
    return (await resp.json()) as BadgeState;
  } catch {
    return null;
  }
}

export interface AuditedTool {
  name: string;
  description: string;
  readOnly?: boolean;
  untrusted?: boolean;
  params?: string[];
}

export interface BadgeReport {
  origin: string;
  state: 'active' | 'revoked' | 'expired' | 'unverified' | 'none';
  fingerprint?: string;
  toolCount?: number | null;
  tools?: AuditedTool[];
  assuranceScore?: number | null;
  assuranceRung?: number;
  flagged?: boolean;
  findings?: ScanFinding[];
  scope?: string;
  signedAt?: string;
  expiresAt?: string | null;
  reportSha256?: string;
  signature?: string;
  keyId?: string;
  fingerprintAlgo?: string;
  error?: string;
}

/** The full, human-readable audit behind a badge (what the badge links to). */
export async function getReport(origin: string): Promise<BadgeReport | null> {
  try {
    const resp = await fetch(mode2Url(`/api/report?origin=${encodeURIComponent(origin)}`));
    if (!resp.ok) return null;
    return (await resp.json()) as BadgeReport;
  } catch {
    return null;
  }
}

export interface StatsData {
  generatedAt: string;
  badges: { active: number; everMinted: number; sites: string[] };
  verification: { started: number; verified: number };
  scans: { total: number; last7d: number; uniqueSites: number; topSites: Array<{ origin: string; scans: number }> };
  agentTests: { total: number; last7d: number; avgResistance: number | null };
  leads: number;
}

/** Admin: the success dashboard. Needs the admin token (x-admin-token). */
export async function getStats(token: string): Promise<{ ok: boolean; status: number; data: StatsData | null }> {
  try {
    const resp = await fetch(mode2Url('/api/stats'), { headers: { 'x-admin-token': token } });
    let data: StatsData | null = null;
    try {
      data = (await resp.json()) as StatsData;
    } catch {
      data = null;
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export interface LeadResult {
  ok: boolean;
  /** True only if a report email was actually sent (Resend configured). */
  emailed: boolean;
}

/** Submit an email opt-in. Reports whether it was accepted and whether an email was actually sent. */
export async function submitLead(
  email: string,
  consent: boolean,
  extra?: { agentLabel?: string; scorecardId?: string },
): Promise<LeadResult> {
  const body: Record<string, unknown> = { email, consent };
  if (extra?.agentLabel) body.agent_label = extra.agentLabel;
  if (extra?.scorecardId) body.scorecard_id = extra.scorecardId;
  const out = (await postJson('/api/lead', body)) as { ok?: boolean; emailed?: boolean } | null;
  return { ok: out?.ok === true, emailed: out?.emailed === true };
}
