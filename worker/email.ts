// worker/email.ts
//
// Optional report-email delivery via Resend. Off by default: sending requires
// both RESEND_API_KEY and RESEND_FROM (a verified sender). Without them,
// isEmailConfigured() is false and the lead is simply captured. Never throws —
// a delivery failure returns false so lead capture always succeeds.

import type { Env } from './types.ts';

export function isEmailConfigured(env: Env): boolean {
  return !!(env.RESEND_API_KEY && env.RESEND_FROM);
}

interface ScorecardSummary {
  agent_label: string;
  resistance_score: number | null;
  resisted: number;
  decided: number;
  results: unknown;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function renderHtml(s: ScorecardSummary): string {
  const pct = s.resistance_score === null ? '—' : `${Math.round(s.resistance_score * 100)}%`;
  const rows = Array.isArray(s.results)
    ? (s.results as Array<{ levelId?: unknown; verdict?: unknown }>)
        .map((r) => `${escapeHtml(String(r.levelId ?? '?'))}: ${escapeHtml(String(r.verdict ?? '?'))}`)
        .join(' · ')
    : '';
  return (
    `<div style="font-family:system-ui,sans-serif;max-width:520px">` +
    `<h2>Trustwright result</h2>` +
    `<p><b>${escapeHtml(s.agent_label)}</b> resisted <b>${s.resisted} of ${s.decided}</b> injection classes (${pct}).</p>` +
    `<p style="color:#555;font-size:13px">${rows}</p>` +
    `<p style="color:#888;font-size:12px">A DeepBlocker project — a pre-ship assurance range for WebMCP developers.</p>` +
    `</div>`
  );
}

// ── Operator alerts (Postmark) ───────────────────────────────────────────────
//
// Badge-health alerts (drift / revoke / near-expiry) go to the operator via
// Postmark, independent of the Resend report path. Off unless BOTH a Postmark
// server token and a destination address are configured. Never throws — the
// monitor records health regardless of whether the email is accepted.

const DEFAULT_ALERT_FROM = 'Trustwright <shield@deepblocker.ai>';

export function isAlertConfigured(env: Env): boolean {
  return !!(env.POSTMARK_SERVER_API_KEY && env.ALERT_EMAIL);
}

export interface BadgeAlert {
  subject: string;
  /** Plain-text lines; also rendered as an HTML list. */
  lines: string[];
  /** Optional lead paragraph above the list. */
  intro?: string;
}

/** Send a badge-health alert to the operator via Postmark. Returns true only if
 *  Postmark accepted it. Never throws. */
export async function sendBadgeAlertEmail(env: Env, alert: BadgeAlert): Promise<boolean> {
  if (!isAlertConfigured(env)) return false;
  const from = env.POSTMARK_FROM || DEFAULT_ALERT_FROM;
  const to = env.ALERT_EMAIL as string;
  const intro = alert.intro ? `<p>${escapeHtml(alert.intro)}</p>` : '';
  const items = alert.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:560px">` +
    `<h2 style="margin:0 0 8px">Trustwright badge alert</h2>` +
    intro +
    `<ul style="color:#333;font-size:14px;line-height:1.6">${items}</ul>` +
    `<p style="color:#888;font-size:12px">Automated monitor · trustwright.deepblocker.ai. ` +
    `You are receiving this because you are the Trustwright operator.</p>` +
    `</div>`;
  const text =
    `Trustwright badge alert\n\n` +
    (alert.intro ? `${alert.intro}\n\n` : '') +
    alert.lines.map((l) => `- ${l}`).join('\n') +
    `\n\nAutomated monitor · trustwright.deepblocker.ai`;
  try {
    const resp = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': env.POSTMARK_SERVER_API_KEY as string,
      },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: alert.subject,
        HtmlBody: html,
        TextBody: text,
        MessageStream: 'outbound',
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Send the report email. Returns true only if Resend accepted it. Never throws. */
export async function sendReportEmail(env: Env, to: string, summary: ScorecardSummary): Promise<boolean> {
  if (!isEmailConfigured(env)) return false;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to,
        subject: `Your Trustwright result — ${summary.resisted}/${summary.decided}`,
        html: renderHtml(summary),
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
