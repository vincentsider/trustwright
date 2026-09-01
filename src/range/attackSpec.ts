// src/range/attackSpec.ts
//
// The v2 attack ENGINE: interpret an attack expressed as DATA (an AttackSpec)
// into the exact LevelDefinition the range already runs. This is what lets a
// private/premium attack ship as a gated JSON file instead of code — data over
// fetch() is CSP-safe, code is not (see Docs/DeepBlocker/Trustwright/v2/…).
//
// SAFETY SPINE (a spec is UNTRUSTED data):
//   - No eval / Function / dynamic import. Every behaviour is a CLOSED enum of
//     effects, conditions, triggers and capabilities; an unknown key => the spec
//     is REJECTED by validateSpec, never partially run.
//   - The canary is ENGINE-minted (from LevelContext), never taken from a spec.
//     `{{canary}}` is the only interpolation into the canary; `{{<flag>}}` reads
//     run state. No spec-controlled URLs, code, or secrets.
//   - Bounded: caps on tools/phases/effects/steps and string lengths.
//   - Capabilities (e.g. the deepfake detector) are ENGINE-owned code referenced
//     by name; the spec never contains the model call, endpoint, or key.
//
// Memory-safety: phase timers are cleared and the current phase's tools disposed
// on teardown (dispose()), reusing shim.ts's registerAll disposer discipline.

import type { JsonSchema, ToolAnnotations, ModelContextTool } from '../webmcp/types.ts';
import { registerAllOn, type Disposer } from '../webmcp/shim.ts';
import { canaryPresent } from './canary.ts';
import type { TelemetryKind } from './telemetry.ts';
import type { Verdict } from './scoring.ts';
import type { LevelDefinition, LevelContext, ArmedLevel, Archetype } from './level.ts';
import { runCapability, CAPABILITY_NAMES, type CapabilityName } from './capabilities.ts';

// ── Caps (bound an untrusted spec) ───────────────────────────────────────────
export const SPEC_MAX_PHASES = 8;
export const SPEC_MAX_TOOLS_PER_PHASE = 24;
export const SPEC_MAX_EFFECTS = 24;
export const SPEC_MAX_STEPS = 24;
export const SPEC_MAX_STR = 4000;
const EFFECT_DEPTH_MAX = 6; // nested `when` guard

// ── The closed vocabulary ────────────────────────────────────────────────────

/** A telemetry kind a spec is allowed to emit (a closed subset). */
const EMIT_KINDS: ReadonlySet<TelemetryKind> = new Set<TelemetryKind>([
  'tool_called',
  'tool_result',
  'toolchange',
  'canary_fired',
  'note',
]);

export type Trigger =
  | { after: 'ms'; ms: number }
  | { after: 'call'; tool: string }
  | { after: 'flag'; flag: string };

export type Effect =
  | { type: 'emit'; kind: TelemetryKind; label?: string; detail?: string }
  | { type: 'return'; text: string }
  | { type: 'fireCanary'; hostile?: boolean; label?: string; detail?: string }
  | { type: 'setFlag'; name: string; value?: string; fromCapability?: string }
  | { type: 'runCapability'; name: string; args?: Record<string, unknown>; as: string }
  | { type: 'advancePhase'; phase: string }
  | { type: 'when'; cond: Condition; then: Effect[]; otherwise?: Effect[] };

export type Condition =
  | { type: 'called'; tool: string }
  | { type: 'calledBefore'; first: string; second: string }
  | { type: 'flag'; name: string }
  | { type: 'flagEquals'; name: string; value: string }
  | { type: 'toolSetChanged' }
  | { type: 'argHasCanary' } // the CURRENT tool call carried the canary in an argument
  | { type: 'not'; cond: Condition }
  | { type: 'allOf'; conds: Condition[] }
  | { type: 'anyOf'; conds: Condition[] };

export interface SpecTool {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  onCall?: Effect[];
}

export interface Phase {
  id: string;
  tools: SpecTool[];
  next?: { phase: string; on: Trigger };
}

export interface PlayStep {
  call: string;
  input?: Record<string, unknown>;
}

export interface Play {
  archetype: Archetype;
  steps: PlayStep[];
}

export interface AttackSpec {
  id: string;
  specVersion: 1;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  title: string;
  brief: string;
  mitigation: string;
  task: string;
  flags?: string[];
  phases: Phase[];
  detection: { fail?: Condition; partial?: Condition };
  plays?: Play[];
}

// ── Validation (closed-vocab, bounded, total) ────────────────────────────────

export type SpecValidation = { ok: true; spec: AttackSpec } | { ok: false; error: string };

function isStr(v: unknown, max = SPEC_MAX_STR): v is string {
  return typeof v === 'string' && v.length <= max;
}
function isPlainObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validateCondition(c: unknown, path: string): string | null {
  if (!isPlainObj(c) || typeof c.type !== 'string') return `${path}: condition must be an object with a type`;
  switch (c.type) {
    case 'called':
      return isStr(c.tool) ? null : `${path}.tool: required string`;
    case 'calledBefore':
      return isStr(c.first) && isStr(c.second) ? null : `${path}: first/second required`;
    case 'flag':
      return isStr(c.name) ? null : `${path}.name: required string`;
    case 'flagEquals':
      return isStr(c.name) && isStr(c.value) ? null : `${path}: name/value required`;
    case 'toolSetChanged':
      return null;
    case 'argHasCanary':
      return null;
    case 'not':
      return validateCondition(c.cond, `${path}.cond`);
    case 'allOf':
    case 'anyOf': {
      const arr = c.type === 'allOf' ? c.conds : c.conds;
      if (!Array.isArray(arr) || arr.length === 0) return `${path}.conds: non-empty array required`;
      for (let i = 0; i < arr.length; i++) {
        const e = validateCondition(arr[i], `${path}.conds[${i}]`);
        if (e) return e;
      }
      return null;
    }
    default:
      return `${path}.type: unknown condition '${String(c.type)}'`;
  }
}

function validateEffects(effects: unknown, path: string, depth: number): string | null {
  if (!Array.isArray(effects)) return `${path}: must be an array`;
  if (effects.length > SPEC_MAX_EFFECTS) return `${path}: too many effects (>${SPEC_MAX_EFFECTS})`;
  if (depth > EFFECT_DEPTH_MAX) return `${path}: effect nesting too deep`;
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    const p = `${path}[${i}]`;
    if (!isPlainObj(e) || typeof e.type !== 'string') return `${p}: effect must be an object with a type`;
    switch (e.type) {
      case 'emit':
        if (typeof e.kind !== 'string' || !EMIT_KINDS.has(e.kind as TelemetryKind)) return `${p}.kind: not an allowed telemetry kind`;
        if (e.label !== undefined && !isStr(e.label)) return `${p}.label`;
        if (e.detail !== undefined && !isStr(e.detail)) return `${p}.detail`;
        break;
      case 'return':
        if (!isStr(e.text)) return `${p}.text: required string`;
        break;
      case 'fireCanary':
        if (e.detail !== undefined && !isStr(e.detail)) return `${p}.detail`;
        if (e.label !== undefined && !isStr(e.label)) return `${p}.label`;
        break;
      case 'setFlag':
        if (!isStr(e.name)) return `${p}.name: required string`;
        if (e.value !== undefined && !isStr(e.value)) return `${p}.value`;
        if (e.fromCapability !== undefined && !isStr(e.fromCapability)) return `${p}.fromCapability`;
        break;
      case 'runCapability':
        if (!isStr(e.name) || !CAPABILITY_NAMES.has(e.name)) return `${p}.name: unknown capability`;
        if (!isStr(e.as)) return `${p}.as: required string`;
        if (e.args !== undefined && !isPlainObj(e.args)) return `${p}.args: must be an object`;
        break;
      case 'advancePhase':
        if (!isStr(e.phase)) return `${p}.phase: required string`;
        break;
      case 'when': {
        const ce = validateCondition(e.cond, `${p}.cond`);
        if (ce) return ce;
        const te = validateEffects(e.then, `${p}.then`, depth + 1);
        if (te) return te;
        if (e.otherwise !== undefined) {
          const oe = validateEffects(e.otherwise, `${p}.otherwise`, depth + 1);
          if (oe) return oe;
        }
        break;
      }
      default:
        return `${p}.type: unknown effect '${String(e.type)}'`;
    }
  }
  return null;
}

function validateTool(t: unknown, path: string): string | null {
  if (!isPlainObj(t)) return `${path}: must be an object`;
  if (typeof t.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(t.name)) return `${path}.name: 1-128 chars [A-Za-z0-9_.-]`;
  if (!isStr(t.description)) return `${path}.description: required string`;
  if (t.inputSchema !== undefined && !isPlainObj(t.inputSchema)) return `${path}.inputSchema: must be an object`;
  if (t.annotations !== undefined && !isPlainObj(t.annotations)) return `${path}.annotations: must be an object`;
  if (t.onCall !== undefined) {
    const e = validateEffects(t.onCall, `${path}.onCall`, 0);
    if (e) return e;
  }
  return null;
}

function validateTrigger(tr: unknown, path: string): string | null {
  if (!isPlainObj(tr) || typeof tr.after !== 'string') return `${path}: trigger requires 'after'`;
  if (tr.after === 'ms') return typeof tr.ms === 'number' && tr.ms >= 0 && tr.ms <= 60000 ? null : `${path}.ms: 0-60000`;
  if (tr.after === 'call') return isStr(tr.tool) ? null : `${path}.tool: required`;
  if (tr.after === 'flag') return isStr(tr.flag) ? null : `${path}.flag: required`;
  return `${path}.after: unknown trigger '${String(tr.after)}'`;
}

/** Strict, total validation of an untrusted spec. Returns a typed error, never throws. */
export function validateSpec(input: unknown): SpecValidation {
  if (!isPlainObj(input)) return { ok: false, error: 'spec must be an object' };
  const s = input as Record<string, unknown>;
  if (s.specVersion !== 1) return { ok: false, error: 'specVersion must be 1' };
  for (const k of ['id', 'category', 'title', 'brief', 'mitigation', 'task'] as const) {
    if (!isStr(s[k], 8000)) return { ok: false, error: `${k}: required string` };
  }
  if (!['easy', 'medium', 'hard'].includes(s.difficulty as string)) return { ok: false, error: 'difficulty: easy|medium|hard' };
  if (s.flags !== undefined && (!Array.isArray(s.flags) || !s.flags.every((f) => isStr(f)))) return { ok: false, error: 'flags: string[]' };

  if (!Array.isArray(s.phases) || s.phases.length === 0) return { ok: false, error: 'phases: non-empty array' };
  if (s.phases.length > SPEC_MAX_PHASES) return { ok: false, error: `phases: too many (>${SPEC_MAX_PHASES})` };
  const phaseIds = new Set<string>();
  for (let i = 0; i < s.phases.length; i++) {
    const ph = s.phases[i];
    if (!isPlainObj(ph) || !isStr(ph.id)) return { ok: false, error: `phases[${i}].id: required` };
    if (phaseIds.has(ph.id)) return { ok: false, error: `phases[${i}].id: duplicate '${ph.id}'` };
    phaseIds.add(ph.id);
    if (!Array.isArray(ph.tools) || ph.tools.length === 0) return { ok: false, error: `phases[${i}].tools: non-empty array` };
    if (ph.tools.length > SPEC_MAX_TOOLS_PER_PHASE) return { ok: false, error: `phases[${i}].tools: too many` };
    for (let j = 0; j < ph.tools.length; j++) {
      const e = validateTool(ph.tools[j], `phases[${i}].tools[${j}]`);
      if (e) return { ok: false, error: e };
    }
    if (ph.next !== undefined) {
      if (!isPlainObj(ph.next) || !isStr(ph.next.phase)) return { ok: false, error: `phases[${i}].next.phase: required` };
      const te = validateTrigger(ph.next.on, `phases[${i}].next.on`);
      if (te) return { ok: false, error: te };
    }
  }
  // Every advancePhase / next target must reference a declared phase.
  for (let i = 0; i < s.phases.length; i++) {
    const nx = (s.phases[i] as Record<string, unknown>).next as { phase?: string } | undefined;
    if (nx?.phase && !phaseIds.has(nx.phase)) return { ok: false, error: `phases[${i}].next.phase: unknown '${nx.phase}'` };
  }

  if (!isPlainObj(s.detection)) return { ok: false, error: 'detection: required object' };
  if (s.detection.fail !== undefined) {
    const e = validateCondition(s.detection.fail, 'detection.fail');
    if (e) return { ok: false, error: e };
  }
  if (s.detection.partial !== undefined) {
    const e = validateCondition(s.detection.partial, 'detection.partial');
    if (e) return { ok: false, error: e };
  }

  if (s.plays !== undefined) {
    if (!Array.isArray(s.plays)) return { ok: false, error: 'plays: array' };
    for (let i = 0; i < s.plays.length; i++) {
      const pl = s.plays[i];
      if (!isPlainObj(pl) || (pl.archetype !== 'compliant' && pl.archetype !== 'careful')) return { ok: false, error: `plays[${i}].archetype: compliant|careful` };
      if (!Array.isArray(pl.steps) || pl.steps.length > SPEC_MAX_STEPS) return { ok: false, error: `plays[${i}].steps` };
      for (let j = 0; j < pl.steps.length; j++) {
        const st = pl.steps[j];
        if (!isPlainObj(st) || !isStr(st.call)) return { ok: false, error: `plays[${i}].steps[${j}].call: required` };
        if (st.input !== undefined && !isPlainObj(st.input)) return { ok: false, error: `plays[${i}].steps[${j}].input: object` };
      }
    }
  }
  return { ok: true, spec: input as unknown as AttackSpec };
}

// ── Interpreter ──────────────────────────────────────────────────────────────

interface RunState {
  canary: string;
  calls: string[]; // tool names in call order
  flags: Map<string, string | boolean>;
  toolSetChanged: boolean;
}

/** Interpolate {{canary}} and {{<flag>}} — the ONLY templating; never code. */
function interpolate(tpl: string, st: RunState): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (name === 'canary') return st.canary;
    const v = st.flags.get(name);
    return v === undefined ? '' : String(v);
  });
}

function interpolateInput(input: Record<string, unknown> | undefined, st: RunState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) out[k] = typeof v === 'string' ? interpolate(v, st) : v;
  return out;
}

// `input` is the argument object of the CURRENT tool call (only `argHasCanary`
// reads it). It is passed explicitly rather than kept on RunState so a concurrent
// tool call (interleaving during a capability await) can never clobber it.
function evalCondition(cond: Condition, st: RunState, input: Record<string, unknown>): boolean {
  switch (cond.type) {
    case 'called':
      return st.calls.includes(cond.tool);
    case 'calledBefore': {
      const a = st.calls.indexOf(cond.first);
      const b = st.calls.indexOf(cond.second);
      return a !== -1 && b !== -1 && a < b;
    }
    case 'flag':
      return !!st.flags.get(cond.name);
    case 'flagEquals':
      return String(st.flags.get(cond.name) ?? '') === cond.value;
    case 'toolSetChanged':
      return st.toolSetChanged;
    case 'argHasCanary':
      return canaryPresent(input, st.canary);
    case 'not':
      return !evalCondition(cond.cond, st, input);
    case 'allOf':
      return cond.conds.every((c) => evalCondition(c, st, input));
    case 'anyOf':
      return cond.conds.some((c) => evalCondition(c, st, input));
  }
}

/** Build the concrete LevelDefinition an existing runner/session consumes. */
export function buildLevelFromSpec(spec: AttackSpec): LevelDefinition {
  return {
    id: spec.id,
    category: spec.category,
    difficulty: spec.difficulty,
    title: spec.title,
    brief: spec.brief,
    mitigation: spec.mitigation,
    task: spec.task,
    async arm(ctx: LevelContext): Promise<ArmedLevel> {
      const st: RunState = { canary: ctx.canary, calls: [], flags: new Map(), toolSetChanged: false };
      for (const f of spec.flags ?? []) st.flags.set(f, false);

      const phaseById = new Map(spec.phases.map((p) => [p.id, p]));
      let currentPhase: Phase | undefined;
      let currentDisposer: Disposer = () => {};
      let phaseTimer: ReturnType<typeof setTimeout> | null = null;
      let disposed = false;

      const clearTimer = () => {
        if (phaseTimer !== null) {
          clearTimeout(phaseTimer);
          phaseTimer = null;
        }
      };

      // Result carrier for a tool's execute() — the `return` effect sets it.
      // `input` is the current call's arguments, threaded to `when`/argHasCanary.
      const runEffects = async (effects: Effect[], carry: { text: string }, input: Record<string, unknown>): Promise<void> => {
        for (const e of effects) {
          switch (e.type) {
            case 'emit':
              ctx.telemetry.emit({ kind: e.kind, ...(e.label ? { label: e.label } : {}), ...(e.detail ? { detail: interpolate(e.detail, st) } : {}) });
              break;
            case 'return':
              carry.text = interpolate(e.text, st);
              break;
            case 'fireCanary':
              ctx.telemetry.emit({
                kind: 'canary_fired',
                ...(e.label ? { label: e.label } : {}),
                detail: e.detail ? interpolate(e.detail, st) : st.canary,
                hostile: e.hostile !== false,
              });
              break;
            case 'setFlag':
              st.flags.set(e.name, e.fromCapability ? String(st.flags.get(e.fromCapability) ?? '') : (e.value ?? true));
              break;
            case 'runCapability':
              st.flags.set(e.as, await runCapability(e.name as CapabilityName, interpolateInput(e.args, st)));
              break;
            case 'advancePhase':
              await advanceTo(e.phase);
              break;
            case 'when':
              await runEffects(evalCondition(e.cond, st, input) ? e.then : (e.otherwise ?? []), carry, input);
              break;
          }
        }
      };

      const toModelTool = (t: SpecTool): ModelContextTool => ({
        name: t.name,
        description: t.description,
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
        execute: async (input) => {
          st.calls.push(t.name);
          const callInput = input ?? {};
          const carry = { text: 'ok' };
          await runEffects(t.onCall ?? [], carry, callInput);
          // Surface swaps (T3 cloaking) fire AFTER the call completes, so the
          // honest tool that was just used is what disappears.
          await maybeTrigger(t.name);
          return carry.text.slice(0, 1500); // honour the WebMCP ~1500-char cap
        },
      });

      const armPhase = async (phase: Phase): Promise<void> => {
        clearTimer();
        currentDisposer(); // dispose the previous phase's tools
        currentPhase = phase;
        currentDisposer = await registerAllOn(ctx.host, phase.tools.map(toModelTool));
        if (disposed) {
          currentDisposer();
          return;
        }
        if (phase.next?.on.after === 'ms') {
          const target = phase.next.phase;
          phaseTimer = setTimeout(() => {
            phaseTimer = null;
            void advanceTo(target);
          }, phase.next.on.ms);
        }
      };

      const advanceTo = async (phaseId: string): Promise<void> => {
        if (disposed) return;
        const next = phaseById.get(phaseId);
        if (!next || next === currentPhase) return;
        st.toolSetChanged = true;
        ctx.telemetry.emit({ kind: 'toolchange', label: phaseId, detail: 'tool surface changed' });
        await armPhase(next);
      };

      const maybeTrigger = async (toolName: string): Promise<void> => {
        const on = currentPhase?.next?.on;
        if (!on) return;
        if (on.after === 'call' && on.tool === toolName) await advanceTo(currentPhase!.next!.phase);
        else if (on.after === 'flag' && st.flags.get(on.flag)) await advanceTo(currentPhase!.next!.phase);
      };

      await armPhase(spec.phases[0]!);

      const play = async (archetype: Archetype): Promise<void> => {
        const p = (spec.plays ?? []).find((x) => x.archetype === archetype);
        if (!p) return;
        for (const step of p.steps) {
          await ctx.host.executeTool(step.call, JSON.stringify(interpolateInput(step.input, st)));
        }
      };

      const evaluate = (): Verdict => {
        // Detection runs over accumulated run state; there is no "current call",
        // so argHasCanary (if a spec used it here) evaluates against an empty input.
        if (spec.detection.fail && evalCondition(spec.detection.fail, st, {})) return 'FAIL';
        if (spec.detection.partial && evalCondition(spec.detection.partial, st, {})) return 'PARTIAL';
        return 'PASS';
      };

      const dispose: Disposer = () => {
        if (disposed) return;
        disposed = true;
        clearTimer();
        currentDisposer();
      };

      return { play, evaluate, dispose };
    },
  };
}
