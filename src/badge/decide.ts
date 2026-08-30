// src/badge/decide.ts
//
// Pure decision for what the live badge should DISPLAY, given the signed state
// from /api/badge and the fingerprint recomputed from the page's ACTUAL tools
// (or null when this browser has no WebMCP host to read them). Kept pure so the
// honesty rules are unit-tested, not buried in DOM code:
//
//   - never a green "verified" that survives a fingerprint mismatch;
//   - never a green "verified" over an audit that recorded a confirmed FAIL —
//     the tools may be genuine, but green must not reassure past a red flag;
//   - a mismatch reads "tools changed — this seal does not apply";
//   - with no host to check, show the SIGNED state ("audited as of ⟨date⟩"),
//     not a scary error and not a false live-verified.

/** Mirrors the /api/badge JSON (kept local so the embed bundles nothing heavy). */
export type BadgeStateJson =
  | { state: 'unverified' | 'none' }
  | { state: 'revoked'; signedAt?: string }
  | { state: 'expired'; signedAt?: string; fingerprint?: string }
  | {
      state: 'active';
      fingerprint: string;
      assuranceScore: number | null;
      /** The signed audit recorded a confirmed FAIL. Absent on older responses. */
      flagged?: boolean;
      signedAt: string;
    };

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface BadgeDisplay {
  label: string;
  tone: Tone;
  sub: string;
}

function day(iso?: string): string {
  return iso ? iso.slice(0, 10) : '';
}

/**
 * The badge's live embed reads the page's tools to decide "verified" vs
 * "changed", but a site commonly installs its WebMCP host and registers its
 * tools ASYNCHRONOUSLY — so for a short grace window after load, an apparent
 * mismatch is far more likely "not registered yet" than a real tool-swap.
 * During that window we suppress the alarming "tools changed" and show the
 * honest signed "tools audited" instead; once the window closes, a persistent
 * mismatch is trusted as a genuine change. A confirmed live MATCH is always
 * shown immediately (grace only ever downgrades an alarm, never a green seal).
 */
export function displayWithGrace(
  state: BadgeStateJson,
  liveFingerprint: string | null,
  graceExpired: boolean,
): BadgeDisplay {
  const d = decideBadge(state, liveFingerprint);
  if (!graceExpired && d.label === 'tools changed') return decideBadge(state, null);
  return d;
}

export function decideBadge(state: BadgeStateJson, liveFingerprint: string | null): BadgeDisplay {
  switch (state.state) {
    case 'unverified':
      return { label: 'not verified', tone: 'neutral', sub: 'origin ownership not proven' };
    case 'none':
      return { label: 'not audited', tone: 'neutral', sub: 'no Trustwright audit on record' };
    case 'revoked':
      return { label: 'revoked', tone: 'bad', sub: 'this badge was withdrawn' };
    case 'expired':
      return { label: 'expired', tone: 'warn', sub: 're-audit required' };
    case 'active': {
      const score = state.assuranceScore === null ? '' : ` · ${Math.round(state.assuranceScore * 100)}% clean`;
      // Integrity first: if we can read the live tools and they no longer match
      // the audited set, the seal does not apply at all.
      if (liveFingerprint !== null && liveFingerprint !== state.fingerprint) {
        return { label: 'tools changed', tone: 'warn', sub: 'the audited tools have changed; this seal does not apply' };
      }
      // Integrity holds (matched, or no host to check) — but a green "verified"
      // must never sit over an audit that found a confirmed red flag. Honesty
      // over reassurance: the tools ARE the audited ones, and one of them failed.
      if (state.flagged) {
        return { label: 'tools flagged', tone: 'warn', sub: `a tool raised a red flag in audit — see report${score}` };
      }
      if (liveFingerprint === null) {
        // No host to read on-page tools: show the signed state, do not claim a live check.
        return { label: 'tools audited', tone: 'ok', sub: `as of ${day(state.signedAt)}${score}` };
      }
      return { label: 'tools verified', tone: 'ok', sub: `live tools match the audit${score}` };
    }
  }
}
