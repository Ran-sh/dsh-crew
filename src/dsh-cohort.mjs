// Single source of truth for the pinned DeepSeek Harness cohort.
//
// The Crew runtime, the SDK client, and the worker composition must all
// resolve to this exact version. All other modules re-export from here so a
// cohort bump touches exactly one file (plus package.json's 48 DSH pins).
export const DSH_CLI_PACKAGE = '@deepseek-ai/dsh';
export const TARGET_DSH_VERSION = '0.2.0-rc.2';
export const TARGET_DSH_SPEC = `${DSH_CLI_PACKAGE}@${TARGET_DSH_VERSION}`;

export const DSH_SCOPE = '@deepseek-ai/';

/** Cohort namespace: the CLI plus every `@deepseek-ai/dsh-*` package. */
export function isDshCohortPackage(name) {
  return name === DSH_CLI_PACKAGE || name.startsWith(`${DSH_CLI_PACKAGE}-`);
}

// WHAT THIS LIST IS: the names a persisted Crew payload pins to
// TARGET_DSH_VERSION when the plugin declares them. It is the payload's cohort
// authority, and it answers one question — "which exact version does this
// package resolve to inside a release?"
//
// WHAT IT IS NOT: an inventory of everything that must exist at run time. The
// runtime tree is a cohort of its own, and `src/dsh-cli-runtime.mjs` judges it
// dynamically — it walks every installed @deepseek-ai/dsh* copy and compares it
// against TARGET_DSH_VERSION, so a member it was never told about still fails
// the reuse gate instead of drifting silently. Adding a name here does not make
// the runtime install it; removing one does not excuse it from that judgement.
//
// Two boundary cases, recorded so they are not re-litigated:
//   * @deepseek-ai/dsh-base and @deepseek-ai/dsh-web-app are PROFILE BUNDLES,
//     named by CREW_PROFILE_DEFAULT_BUNDLES in src/dsh-cli-runtime.mjs. They
//     belong to the runtime tree the profile composes, not to this plugin's
//     peer set, so they are correctly absent here. A payload never vendors them.
//   * @deepseek-ai/dsh-agent-preset-registry is the provider of the
//     `agentPresets` service this plugin resolves, and it is declared, so it is
//     both pinned here and carried as a peer. Its predecessor
//     `@deepseek-ai/dsh-agent-presets` stopped publishing at 0.1.6-alpha.2 and is
//     named nowhere — a cohort that still listed it would be describing a package
//     no registry can serve.
//
// The list is authoritative wherever a member is declared: a peer range and an
// explicit dependency both resolve to TARGET_DSH_VERSION in the staged payload.
// A package that exists only in a later cohort — a rename, for example — belongs
// in the peer block for that host and must NOT be added here until
// TARGET_DSH_VERSION moves with it.
export const DSH_COHORT_PACKAGES = Object.freeze([
  DSH_CLI_PACKAGE,
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-agent-preset-registry',
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
