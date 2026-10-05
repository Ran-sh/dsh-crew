// Single source of truth for the pinned DeepSeek Harness cohort.
//
// The Crew runtime, the SDK client, and the worker composition must all
// resolve to this exact version. All other modules re-export from here so a
// cohort bump touches exactly one file (plus package.json's 48 DSH pins).
export const DSH_CLI_PACKAGE = '@deepseek-ai/dsh';
export const TARGET_DSH_VERSION = '0.1.6-alpha.1';
export const TARGET_DSH_SPEC = `${DSH_CLI_PACKAGE}@${TARGET_DSH_VERSION}`;

export const DSH_SCOPE = '@deepseek-ai/';

/** Cohort namespace: the CLI plus every `@deepseek-ai/dsh-*` package. */
export function isDshCohortPackage(name) {
  return name === DSH_CLI_PACKAGE || name.startsWith(`${DSH_CLI_PACKAGE}-`);
}

// The packages a persisted Crew payload vendors, at TARGET_DSH_VERSION.
//
// This list — not `package.json`'s DSH peer keys — decides what the standalone
// payload installs. The two answer different questions: a peer key declares
// which hosts will load the plugin, so it carries a RANGE that a host gate
// compares against the running version, while a released payload must resolve
// ONE exact cohort, because a half-upgraded tree is the failure it exists to
// prevent. Reading the payload cohort out of the peer block conflated them, so
// widening a peer range silently unlocked the cohort: nothing stayed pinned,
// `exactSpecOverrides` produced no overrides, and npm materialized the newest
// matching release instead of the one the embedded runtime runs.
//
// Names here are the cohort of TARGET_DSH_VERSION. A package that exists only
// in a later cohort (a rename, for example) belongs in the peer block for that
// host and must NOT be added here until TARGET_DSH_VERSION moves with it.
export const DSH_COHORT_PACKAGES = Object.freeze([
  DSH_CLI_PACKAGE,
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-todo',
]);

/** Exact `name -> TARGET_DSH_VERSION` specs for the vendored payload cohort. */
export function dshCohortPins(version = TARGET_DSH_VERSION) {
  const pins = {};
  for (const name of DSH_COHORT_PACKAGES) pins[name] = version;
  return pins;
}

// Retained-cohort support: when a release's manifest pins an older DSH
// cohort than the current TARGET, the old runtime is retained on disk so a
// rollback can restore it offline (no registry round-trip).
export const RETAINED_RUNTIMES_DIRNAME = 'retained-runtimes';

// Lifecycle-owned cohort metadata for a managed release. Historical releases
// (pre-1.0.4) did not pin @deepseek-ai/dsh in their manifest; this sidecar
// records the runtime cohort fact the lifecycle observed for them WITHOUT
// mutating the immutable release manifest. Resolution priority:
//   manifest exact pin -> sidecar -> (legacy discovery) -> fail closed.
export const RELEASE_COHORT_FILENAME = 'release-cohort.json';
