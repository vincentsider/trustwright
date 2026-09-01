// src/ui/persist.ts
//
// Pure decision for when a completed run should be persisted. Extracted so the
// "save exactly once per finished run, whatever drove it" rule is unit-tested
// rather than buried in an effect. The bug this fixes: saving used to live only
// in the simulated-run button handler, so agent-driven runs (start_run /
// complete_level) never persisted.

/**
 * Save iff the run is done, we are not already saving, and this run (identified
 * by its generatedAt key) has not been saved yet.
 */
export function shouldSaveRun(
  status: string,
  runKey: string,
  lastSavedKey: string | null,
  saving: boolean,
): boolean {
  return status === 'done' && !saving && runKey !== lastSavedKey;
}

/**
 * Whether a finished run may post to the PUBLIC leaderboard. Only a real
 * agent-driven run (not the scripted demo) against the OFFICIAL corpus counts:
 * a run that included any user-authored "bring your own attack" level is not
 * ranked, so a trivially-passable self-written level cannot inflate a score.
 */
export function rankEligible(runKind: 'demo' | 'agent' | null, customLevelCount: number): boolean {
  return runKind === 'agent' && customLevelCount === 0;
}
