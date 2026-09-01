import { describe, it, expect } from 'vitest';
import { derive, isLevelTool } from './AttackTheater.tsx';
import type { TelemetryEvent } from '../range/telemetry.ts';

// Build a minimal event stream (seq/t are irrelevant to derive).
function ev(kind: TelemetryEvent['kind'], label?: string, detail?: string): TelemetryEvent {
  return { seq: 0, t: 0, kind, ...(label ? { label } : {}), ...(detail ? { detail } : {}) };
}

describe('AttackTheater.derive', () => {
  it('is idle for an empty stream', () => {
    const d = derive([]);
    expect(d.levelId).toBeNull();
    expect(d.called.size).toBe(0);
    expect(d.verdict).toBeNull();
    expect(d.history).toEqual([]);
  });

  it('tracks the current level, its calls, and a landed trap', () => {
    const d = derive([
      ev('level_started', 'T1'),
      ev('tool_called', 'search_docs'),
      ev('tool_called', 'attach_note'),
      ev('canary_fired', 'attach_note'),
      ev('level_scored', 'T1', 'FAIL'),
    ]);
    expect(d.levelId).toBe('T1');
    expect([...d.called].sort()).toEqual(['attach_note', 'search_docs']);
    expect([...d.traps]).toEqual(['attach_note']);
    expect(d.verdict).toBe('FAIL');
    expect(d.history).toEqual([{ levelId: 'T1', verdict: 'FAIL' }]);
  });

  it('flags a surface swap (rug-pull) via toolchange', () => {
    const d = derive([
      ev('level_started', 'T3'),
      ev('tool_called', 'list_invoices'),
      ev('toolchange', 'swapped'),
      ev('level_scored', 'T3', 'PASS'),
    ]);
    expect(d.swapped).toBe(true);
    expect(d.verdict).toBe('PASS');
  });

  it('resets per-level state at the next level_started but keeps history', () => {
    const d = derive([
      ev('level_started', 'T1'),
      ev('tool_called', 'attach_note'),
      ev('canary_fired', 'attach_note'),
      ev('level_scored', 'T1', 'FAIL'),
      ev('level_started', 'T2'),
      ev('tool_called', 'read_page'),
    ]);
    // Current level is T2, with fresh call/trap state.
    expect(d.levelId).toBe('T2');
    expect([...d.called]).toEqual(['read_page']);
    expect(d.traps.size).toBe(0);
    expect(d.swapped).toBe(false);
    expect(d.verdict).toBeNull();
    // But history accumulates across levels.
    expect(d.history).toEqual([{ levelId: 'T1', verdict: 'FAIL' }]);
  });

  it('holds the scored level (with verdict) until the next level starts', () => {
    const d = derive([ev('level_started', 'T5'), ev('tool_called', 'x'), ev('level_scored', 'T5', 'PARTIAL')]);
    expect(d.levelId).toBe('T5');
    expect(d.verdict).toBe('PARTIAL');
  });
});

describe('isLevelTool (theater shows only the level under test)', () => {
  it('keeps a level attack tool', () => {
    for (const name of ['search_docs', 'attach_note', 'get_invoice', 'read_message', 'authorize_transfer']) {
      expect(isLevelTool(name)).toBe(true);
    }
  });

  it("excludes the site's own agent tools and the badge verify tool", () => {
    for (const name of [
      'trustwright_scan_site',
      'trustwright_check_badge',
      'trustwright_what_is_tested',
      'trustwright_test_agent',
      'trustwright_start_verification',
      'trustwright_verify_badge',
    ]) {
      expect(isLevelTool(name)).toBe(false);
    }
  });

  it('excludes the range control tools', () => {
    for (const name of ['start_run', 'complete_level', 'list_levels', 'get_scorecard', 'explain_finding', 'export_report', 'get_run_state']) {
      expect(isLevelTool(name)).toBe(false);
    }
  });
});
