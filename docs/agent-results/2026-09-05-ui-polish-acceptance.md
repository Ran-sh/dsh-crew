# Crew UI polish acceptance

Code candidate: `8c5f87d881217e99db99de5f0640bb212c9e71f1`.
Branch: `codex/official-frontend-launcher`. No npm publication or main merge.

## UI changes

- Shared compact header, scoped neutral surfaces, consistent navigation buttons,
  focus indicators, dark-mode accent and reduced-motion handling.
- 3080: ordered model rows with separate model/provider text, aligned accessible
  reorder/remove actions, collapsible role/multimodal groups and add forms.
  Worker is initially expanded; Reviewer and multimodal initially collapsed.
- 3210: smaller introductory area, stacked section titles/summaries with long
  text wrapping, localized running counts and installation wording.
- Existing task tables, configuration operations, official settings shell and
  reciprocal 3080/3210 links are retained.

## Evidence

- TDD RED `3e4bfa6` → GREEN `e4fb5c5` for UI grouping/accessibility.
- Real-browser testing found an unshipped shared-chunk dependency introduced by
  extracting common UI code. RED `7d45b67` → GREEN `75a8600`: entry points now
  build separately, with a packaging guard against relative runtime imports.
- Browser persistence assertions added in `8c5f87d`.
- 58 targeted Node tests passed, zero failed/skipped. TypeScript and builds pass.
  Whole-project coverage was not measured in this slice.
- CI passed: https://github.com/Ran-sh/dsh-crew/actions/runs/33968753554
- Isolated Chromium loaded the actual shipped bundles and exercised model
  add/remove/reorder, master toggle, expand/collapse, Pro/multimodal persistence
  across saves, English controls, narrow layouts and dark mode. Zero page errors.
  All HTTP requests in this test are intercepted; no user configuration changes.
- DSH review `wf-mtoelzab-27sr0s` requested changes based on suspected disclosure
  collapse. Browser evidence disproved it. Follow-up `wf-mtoew1rp-6sxc46`
  explicitly withdrew that finding and approved the candidate. Both reviews
  were read-only with complete delivery and released worktrees.

## Installed verification

User explicitly authorized updating and reloading both instances. Global CLI
and managed release `20260905T132445Z-21716-1-1.2.0-rc.4` were installed from the
local candidate, with no npm publication. First-party source/global/managed
content digest matches:
`cedd5b11f51c4892b13dff485e73def638e498eaf01106b77b23272493a8ab3a`.

Frontend revision:
`f9a40ba188652d246a6e9d456b6992369c9c99875b5c236f36373df0adc89785`.

The backend updater activated runtime
`25384955-1370-45d1-b9a1-461e846368d9`. Afterwards, the separately authorized
official 3080 reload kept that backend runtime unchanged.

Isolated headless Chrome then authenticated to the real local instances using
their CLI-issued local launch URLs, opened Settings → DSH Crew and captured the
actual installed panels. No configuration actions were taken on live services.
3080 displayed the quick panel and its 3210 link. After initial configuration
loading, 3210 displayed all 11 sections, installed host badges and its 3080 link.
Both pages reported zero uncaught page errors. Screenshots were visually
inspected; local artifacts are under:
`C:/Users/48376/AppData/Local/Temp/crew-ui-installed-7t1A4x/`.

The user's Crew config.json and Harness settings.yaml SHA-256 values are
unchanged. This validates the UI slice, not all models or every project feature.
