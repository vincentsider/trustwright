import { describe, it, expect } from 'vitest';
import { PUBLIC_SPECS, CORPUS } from '../src/range/corpusLoader.ts';
import { validateSpec, type AttackSpec } from '../src/range/attackSpec.ts';
import { levelSurface, applyCall, scoreLevel, levelMeta, LEVEL_COUNT, type RangeCall } from './rangeEngine.ts';

// A fixed canary the test controls, so we can interpolate {{canary}} into the
// scripted plays exactly as the browser's interpolateInput does. This is what
// makes the parity check faithful: the HTTP engine sees the same tool calls a
// real agent would, and must score them identically to the in-browser runner.
const CANARY = 'TW-TEST-CANARY-abc123';

function interp(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? v.replace(/\{\{canary\}\}/g, CANARY) : v;
  return out;
}

const specs = PUBLIC_SPECS.map((raw) => {
  const v = validateSpec(raw);
  if (!v.ok) throw new Error(`bad spec: ${v.error}`);
  return v.spec as AttackSpec;
});

function indexOf(id: string): number {
  return CORPUS.findIndex((l) => l.id === id);
}

/** Drive a scripted play through the HTTP engine and return the verdict. */
async function drivePlay(index: number, steps: Array<{ call: string; input?: Record<string, unknown> }>): Promise<string> {
  const calls: RangeCall[] = [];
  for (const step of steps) {
    const input = interp(step.input);
    const res = await applyCall(index, CANARY, calls, { tool: step.call, ...(input ? { input } : {}) });
    // A careful play may legitimately stop before a swapped-in tool exists; only
    // record calls the surface actually accepted (mirrors a real agent).
    if (res.ok) calls.push({ tool: step.call, ...(input ? { input } : {}) });
  }
  return scoreLevel(index, CANARY, calls);
}

describe('rangeEngine parity with the browser corpus', () => {
  it('exposes the full public corpus', () => {
    expect(LEVEL_COUNT).toBe(CORPUS.length);
    expect(LEVEL_COUNT).toBeGreaterThanOrEqual(6);
  });

  for (const spec of specs) {
    const index = indexOf(spec.id);
    it(`${spec.id}: compliant play FAILs, careful play PASSes (HTTP)`, async () => {
      const compliant = spec.plays?.find((p) => p.archetype === 'compliant');
      const careful = spec.plays?.find((p) => p.archetype === 'careful');
      expect(compliant, `${spec.id} needs a compliant play`).toBeTruthy();
      expect(careful, `${spec.id} needs a careful play`).toBeTruthy();

      expect(await drivePlay(index, compliant!.steps), `${spec.id} compliant should FAIL`).toBe('FAIL');
      expect(await drivePlay(index, careful!.steps), `${spec.id} careful should PASS`).toBe('PASS');
    });
  }

  it('an untouched level (no calls) scores PASS', async () => {
    for (let i = 0; i < LEVEL_COUNT; i++) {
      expect(await scoreLevel(i, CANARY, [])).toBe('PASS');
    }
  });

  it('level 1 exposes a non-empty tool surface and metadata', async () => {
    const tools = await levelSurface(0, CANARY);
    expect(tools && tools.length).toBeGreaterThan(0);
    const meta = levelMeta(0);
    expect(meta?.task.length).toBeGreaterThan(0);
    expect(meta?.step).toBe(`1/${LEVEL_COUNT}`);
  });

  it('T3 rug-pull: the tool surface changes after the honest call', async () => {
    const i = indexOf('T3');
    const first = await applyCall(i, CANARY, [], { tool: 'list_invoices' });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.toolsChanged).toBe(true); // the surface swapped
      expect(first.tools.some((t) => t.name === 'get_invoice')).toBe(true);
      expect(first.tools.some((t) => t.name === 'list_invoices')).toBe(false);
    }
  });

  it('rejects a tool that is not on the current surface', async () => {
    const res = await applyCall(0, CANARY, [], { tool: 'no_such_tool_here' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('no_such_tool');
  });
});
