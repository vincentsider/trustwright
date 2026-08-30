// src/range/surfaceReport.ts
//
// The Mode-2 Assurance Report: a sealed, dated record of a surface audit. It
// mirrors Mode 1's report.ts (canonical JSON + SHA-256 seal) and additionally
// carries the fingerprint the badge binds to and the achieved assurance rung.
//
// The Worker adds an Ed25519 SIGNATURE over the canonical form when it issues a
// badge (that lives in the Worker, which holds the private key). This module is
// the portable, deterministic report structure + hash both sides agree on.

import type { SurfaceAudit } from './mode2.ts';

/** Assurance rung reached (Section 5.5). 0 = surface-only (client badge). */
export type AssuranceRung = 0 | 1 | 2 | 3 | 4;

export interface SurfaceReport {
  kind: 'surface-audit';
  version: '1';
  origin: string;
  fingerprint: string;
  /** Per-tool fingerprints of the sealed surface (sorted). Lets the live badge
   *  verify each audited tool is still present/unchanged while tolerating an
   *  extra tool a dynamic site adds at runtime. Absent on pre-v1.1 reports. */
  toolFingerprints?: string[];
  assuranceScore: number | null;
  assuranceRung: AssuranceRung;
  findings: Array<{
    toolName: string | null;
    check: string;
    verdict: string;
    layer: string;
    evidence?: string;
  }>;
  scope: string;
  generatedAt: string; // ISO 8601
}

export interface SealedSurfaceReport {
  report: SurfaceReport;
  canonical: string;
  sha256: string;
}

/**
 * The verbatim scope statement (Section 5). This exact text must appear on the
 * report and badge; it is what keeps the badge from overclaiming. `<date>` and
 * `<short-hash>` are filled from the report.
 */
export function scopeStatement(generatedAt: string, fingerprint: string): string {
  const date = generatedAt.slice(0, 10);
  const short = fingerprint.slice(0, 12);
  return (
    "Trustwright audits this site's agent-tool surface: what these tools declare " +
    '(names, descriptions, input schemas, safety hints, cross-origin exposure) and, ' +
    'where the owner authorised it, what they observably do from the browser. It is ' +
    'verified live against the audited tools present at page load: if an audited ' +
    'tool is removed or changed, this seal stops applying (a tool the site adds at ' +
    'runtime is reported as un-audited, not as tampering). It does not certify ' +
    `server-side behaviour, which cannot be observed from the client. Audited ${date}; fingerprint ${short}.`
  );
}

/** Build the report from an analysed surface + its fingerprint. */
export function buildSurfaceReport(
  audit: SurfaceAudit,
  fingerprint: string,
  origin: string,
  generatedAtIso: string,
  assuranceRung: AssuranceRung = 0,
  toolFingerprints?: string[],
): SurfaceReport {
  return {
    kind: 'surface-audit',
    version: '1',
    origin,
    fingerprint,
    ...(toolFingerprints ? { toolFingerprints } : {}),
    assuranceScore: audit.scorecard.resistanceScore,
    assuranceRung,
    findings: audit.findings.map((f) => ({
      toolName: f.toolName,
      check: f.check,
      verdict: f.verdict,
      layer: f.layer,
      ...(f.evidence ? { evidence: f.evidence } : {}),
    })),
    scope: scopeStatement(generatedAtIso, fingerprint),
    generatedAt: generatedAtIso,
  };
}

/** Canonical JSON with a fixed key order, so the same report always hashes/signs identically. */
export function canonicalSurfaceReport(report: SurfaceReport): string {
  const ordered = {
    kind: report.kind,
    version: report.version,
    origin: report.origin,
    fingerprint: report.fingerprint,
    // Included ONLY when present, so pre-v1.1 reports (no per-tool hashes) hash
    // exactly as before and their existing seals stay valid.
    ...(report.toolFingerprints ? { toolFingerprints: report.toolFingerprints } : {}),
    assuranceScore: report.assuranceScore,
    assuranceRung: report.assuranceRung,
    findings: report.findings.map((f) => ({
      toolName: f.toolName,
      check: f.check,
      verdict: f.verdict,
      layer: f.layer,
      evidence: f.evidence ?? null,
    })),
    scope: report.scope,
    generatedAt: report.generatedAt,
  };
  return JSON.stringify(ordered);
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 seal over the canonical report. */
export async function sealSurfaceReport(report: SurfaceReport): Promise<SealedSurfaceReport> {
  const canonical = canonicalSurfaceReport(report);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { report, canonical, sha256: 'unavailable' };
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return { report, canonical, sha256: toHex(digest) };
}
