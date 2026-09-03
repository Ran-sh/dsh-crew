// Single source of truth for the pinned DeepSeek Harness cohort.
//
// The Crew runtime, the SDK client, and the worker composition must all
// resolve to this exact version. All other modules re-export from here so a
// cohort bump touches exactly one file (plus package.json's 48 DSH pins).
export const DSH_CLI_PACKAGE = '@deepseek-ai/dsh';
export const TARGET_DSH_VERSION = '0.1.2-rc.1';
export const TARGET_DSH_SPEC = `${DSH_CLI_PACKAGE}@${TARGET_DSH_VERSION}`;

// Retained-cohort support: when a release's manifest pins an older DSH
// cohort than the current TARGET, the old runtime is retained on disk so a
// rollback can restore it offline (no registry round-trip).
export const RETAINED_RUNTIMES_DIRNAME = 'retained-runtimes';
