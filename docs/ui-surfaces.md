# 3210 and 3080 UI responsibilities

DSH Crew is a plugin attached to the official DeepSeek Harness. Current installs
register it in a dedicated official Harness `dsh-crew` profile whose native 3210
page is the canonical full Crew control and execution surface. An older
installation may still expose a narrow 3080 quick-controls bundle, but that
legacy surface is external to Crew ownership, optional, and deprecated. Crew
treats the official profile as read-only. The legacy surface
never starts, owns, or supervises 3210.

## 3210: official Harness profile with the Crew plugin

The Crew-owned official Harness `dsh-crew` profile on `127.0.0.1:3210` loads the
DSH Crew plugin and owns day-to-day Crew management and model execution:

- Crew workflow and global enablement
- Worker and Reviewer policy
- model priority, fallback, review, and adaptive routing
- multimodal (vision/imagegen) capability switches
- providers lifecycle (migrate/delete/rollback/quarantine)
- credential references lifecycle
- workspaces, presets, jobs
- installation integrations (Codex, Claude, ZCode)
- task status and bounded model-invocation summaries

Bundle: `lib/client.js` (module `@ran-sh/dsh-crew`), built from
`src/client/entry.tsx`.

## 3080: deprecated legacy quick-controls surface

An older official Harness `web` profile on `127.0.0.1:3080` may still host a
NARROW quick-controls card — and nothing else:

- master switch (`subagents_enabled`)
- Flash / Pro model priority lists (add/remove/reorder only)
- vision / imagegen toggles + providers (restart-pending flow)
- deep link to the 3210 full control plane (`http://127.0.0.1:3210/`)

Bundle: `official-web-bridge/lib/client.js` (module
`@ran-sh/dsh-crew-web-bridge`), built from `src/client/quick-entry.tsx`.
It physically contains none of the full control-plane code (no credential
purge, no provider delete/migration, no install integration).

The 3080 bridge proxies ONLY four exact endpoints to 3210:
`quick-config`, `quick-status`, `runtime/restart-request`,
`runtime/restart-status`. Everything else on the Crew namespace is 404 on
3080, and `/supervisor/restart` returns 410 Gone pointing at 3210.

The official `~/.dsh` tree is strictly read-only for Crew; the 3080 quick
surface itself is optional — Crew works fully with 3080 closed.

## UNKNOWN: diagnostics only

Unknown surfaces render diagnostics and never gain write authority.

## Surface detection and failure behavior

The client does not infer responsibility from a hard-coded browser port. It
uses two same-origin, structured signals:

1. `/_dsh/dsh-crew/bridge-status` identifies the official quick bridge.
2. `/_dsh/dsh-crew/runtime` identifies the native Crew-owned runtime.

The bridge signal wins on 3080 because the proxied runtime response correctly
describes the 3210 backend. If neither contract can be verified, the client
fails closed to the diagnostics view. Missing evidence never enables the
full control plane and never becomes `READY`.

The split changes presentation only. Crew state, credentials, routing policy,
and model execution remain isolated under the Crew-owned home and profile.

## Local trust model

Both surfaces listen on loopback only and share one request guard
(`src/local-request-guard.mjs`). A request is trusted when it proves, in
order: (1) the TCP peer is a loopback address, (2) the `Host` header names a
loopback host, (3) browser fetch-metadata (`Sec-Fetch-Site`) is `same-origin`
or absent/`none`, and (4) when an `Origin` header is present it names a
loopback host — on the 3080 bridge the `Origin` authority must additionally
equal the request authority, while the 3210 hub accepts any loopback origin
because the 3080 panel calls it cross-port.

There is deliberately no bearer token: every process running as the local
user is inside the trust boundary and may control Crew. The guards keep
off-machine browsers, DNS-rebinding pages, and cross-machine proxies out;
they do not authenticate local users. If a deployment ever needs to separate
local principals, add a per-install random token to state-changing calls and
inject it server-side in the bridge — do not use browser `Origin` as
authentication.

## Process ownership

The Windows launcher supervisor (`windows/start-dsh-crew.ps1` watch mode) is
the ONLY process authority for the Crew-owned 3210 service. The official 3080
surface never starts, owns, or supervises 3210. Restart and maintenance go
through durable request files the hub writes and the launcher executes
(`supervisor/restart-request.mjs`). A legacy 3080 bridge is probed only
diagnostically after 3210 readiness and never gates startup.
