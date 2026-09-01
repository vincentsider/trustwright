// src/range/corpusLoader.ts
//
// Assembles the runnable corpus from DATA (validated AttackSpecs) instead of
// hand-written code. This is the seam the whole v2 monetization rests on: the
// PUBLIC corpus is bundled here (and is Apache-2.0), while PREMIUM specs are
// fetched at runtime from the gated /api/corpus endpoint and appended — same
// interpreter, no code shipped, entitlement-checked server-side.
//
// A spec that fails validation is dropped (logged) rather than crashing the
// range: one bad premium spec must never take the board down.

import { validateSpec, buildLevelFromSpec } from './attackSpec.ts';
import type { LevelDefinition } from './level.ts';
import T1 from './corpus/public/T1.json';
import T2 from './corpus/public/T2.json';
import T3 from './corpus/public/T3.json';
import T5 from './corpus/public/T5.json';
import T6 from './corpus/public/T6.json';
import T7 from './corpus/public/T7.json';
import T8 from './corpus/public/T8.json';
import T9 from './corpus/public/T9.json';

/** The bundled, open, ordered public corpus (as raw specs). */
export const PUBLIC_SPECS: readonly unknown[] = [T1, T2, T3, T5, T6, T7, T8, T9];

/** Validate + build a list of specs into runnable levels, dropping invalid ones. */
export function buildCorpus(specs: readonly unknown[]): LevelDefinition[] {
  const out: LevelDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of specs) {
    const v = validateSpec(raw);
    if (!v.ok) {
      console.warn('[corpus] dropped invalid spec:', v.error);
      continue;
    }
    if (seen.has(v.spec.id)) {
      console.warn('[corpus] dropped duplicate spec id:', v.spec.id);
      continue;
    }
    seen.add(v.spec.id);
    out.push(buildLevelFromSpec(v.spec));
  }
  return out;
}

/** The public corpus, built once. */
export const CORPUS: LevelDefinition[] = buildCorpus(PUBLIC_SPECS);

/** Look up a level by id in a corpus (defaults to the public one). */
export function levelById(id: string, corpus: LevelDefinition[] = CORPUS): LevelDefinition | undefined {
  return corpus.find((l) => l.id === id);
}

/** Public corpus + any premium specs already fetched from /api/corpus. Premium
 *  specs pass through the SAME validateSpec, so a malformed one is dropped, never
 *  trusted — a gated premium attack is exactly as safe as a bundled one. */
export function buildFullCorpus(premiumSpecs: readonly unknown[]): LevelDefinition[] {
  return buildCorpus([...PUBLIC_SPECS, ...premiumSpecs]);
}
