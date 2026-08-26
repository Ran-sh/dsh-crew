# 3080 and 3210 UI responsibilities

DSH Crew deliberately presents two different user experiences from one shared
client build.

## 3080: daily Crew control plane

The official Harness `web` profile on `127.0.0.1:3080` owns day-to-day Crew
management:

- Crew workflow and global enablement
- Worker and Reviewer policy
- model priority, fallback, review, and adaptive routing
- runtime and activation-boundary information
- Codex and Claude installation actions and structured readiness
- task status and bounded model-invocation summaries
- the link to the underlying 3210 Crew Harness

The lightweight official-web bridge keeps these requests same-origin and
proxies only the `/_dsh/dsh-crew/*` contract to the isolated backend.

## 3210: isolated native Harness

The Crew-owned `dsh-crew` profile on `127.0.0.1:3210` owns model execution and
low-level Harness configuration. Its native Harness menus remain the place for
Providers, Harness Models, Agent presets, and native runtime settings.

The DSH Crew settings entry on this surface is intentionally diagnostics-only:
it shows bounded runtime identity and a link back to 3080. It does not duplicate
Worker/Reviewer policy, host integrations, tasks, or orchestration controls.

## Surface detection and failure behavior

The client does not infer responsibility from a hard-coded browser port. It
uses two same-origin, structured signals:

1. `/_dsh/dsh-crew/bridge-status` identifies the official bridge control plane.
2. `/_dsh/dsh-crew/runtime` identifies the native Crew-owned runtime.

The bridge signal wins on 3080 because the proxied runtime response correctly
describes the 3210 backend. If neither contract can be verified, the client
fails closed to the minimal diagnostics view. Missing evidence never enables
the full control plane and never becomes `READY`.

The split changes presentation only. Crew state, credentials, routing policy,
and model execution remain isolated under the Crew-owned home and profile.

