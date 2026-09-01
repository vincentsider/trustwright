// src/ui/FindingsList.tsx
//
// Renders a scan/audit's per-tool findings in plain language. Only PARTIAL and
// FAIL findings are shown by default (a PASS list is noise for a non-technical
// operator); a summary line states how many checks passed.

import type { ScanFinding } from '../data/api.ts';

export const CHECK_LABEL: Record<string, string> = {
  T1: 'Instruction hidden in a tool description',
  T2: 'Returns untrusted content without a warning label',
  T3: 'Tool set changed between reads (cloaking)',
  T5: 'Marked read-only but can change data',
  T6: 'Takes a parameter that can relay data off-site',
  T7: 'Makes a trust or safety claim in its description',
};

function verdictPill(v: ScanFinding['verdict']) {
  if (v === 'FAIL') return <span className="pill pill-fail">flag</span>;
  if (v === 'PARTIAL') return <span className="pill pill-partial">worth a look</span>;
  return <span className="pill pill-pass">ok</span>;
}

export function FindingsList({ findings }: { findings: ScanFinding[] }) {
  const flagged = findings.filter((f) => f.verdict !== 'PASS');
  const passed = findings.length - flagged.length;

  if (findings.length === 0) return null;

  return (
    <div>
      {flagged.length > 0 && (
        <div className="findings">
          {flagged.map((f, i) => (
            <div className="finding" key={`${f.toolName}-${f.check}-${i}`}>
              {verdictPill(f.verdict)}
              <span>
                <span className="fname">{f.toolName ?? 'surface'}</span>{' '}
                <span className="fev">· {CHECK_LABEL[f.check] ?? f.check}
                {f.evidence ? `: ${f.evidence}` : ''}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="muted-3" style={{ fontSize: 12.5, marginTop: 12, fontFamily: 'var(--mono, monospace)' }}>
        {passed} check{passed === 1 ? '' : 's'} passed
      </div>
    </div>
  );
}
