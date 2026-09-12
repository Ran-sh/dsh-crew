# Review request: worktree naming, atomic reservation, and OIDC publishing in DSH Crew

You are reviewing the current state of the `main` branch of
`github.com/Ran-sh/dsh-crew` (commit 29569e6, tag v1.10.0). This request covers
three changes that landed together, all shipped to npm as 1.10.0.

## Project briefing

DSH Crew (`@ran-sh/dsh-crew`) is a plugin on the official DeepSeek Harness. A hub
on 3210 dispatches jobs to worker/reviewer models. When `isolation: worktree` is
set, each coding job runs in its own detached git worktree at a captured base
revision, so concurrent workers never share a mutable tree; cleanup removes the
worktree per job. Publishing used to be a local `npm publish` that required an
interactive browser 2FA approval every release.

Relevant modules:
- `src/workspace-isolation.mjs` — worktree lifecycle: naming, reservation,
  creation, candidate capture, cleanup, stale detection/pruning.
- `src/mcp-runtime.mjs` — `allocateWorkspace` picks shared vs worktree per job and
  calls `createIsolatedWorkspace`.
- `.github/workflows/publish.yml` — new OIDC publish workflow.
- `src/install/crew-skill.mjs` + `src/install/install-legacy.mjs` — Crew guidance
  is installed as a per-host skill; retention keeps only what it should.

## The three changes, and why each is shaped the way it is

### 1. Worktrees are named `Crew_<date>_<time>_<purpose>`

The old name was a job id plus random hex, which told an operator nothing. The
purpose is the job's role (`worker` / `reviewer`). Worktrees created before the
rename still start with `dsh-crew-`, and retention recognises both prefixes so
old trees are still adopted and cleaned up.

### 2. The worktree directory is reserved by mkdir, not chosen by probe

`worktreeName` is decided before anything exists. Two jobs starting in the same
second with the same purpose both saw the name free under a check-then-act
scheme, took it, and one lost the race on `git worktree add`. The name is now
allocated by `mkdirSync(dir)`, which fails on collision, so the suffix loop is
race-free. If `git worktree add` then refuses, the reservation is released so a
retry is not blocked.

### 3. The main working tree is never a stale Crew worktree

Retention lists worktrees whose directory name starts with a Crew prefix and
prunes the ones outside the allowed set. A repo whose own directory starts that
way — say a checkout named `dsh-crew-something` — would land in that list. Nothing
was destroyed (git refuses to remove a main working tree, and the fs fallback is
guarded by a path-identity check against the repo root), but every prune would
have produced a confusing lock error. `git worktree list` puts the main working
tree first, so the position in the list is what identifies it — matching the repo
root by path cannot work, because inspecting from inside a linked worktree
reports that worktree as the top level.

### 4. Publishing moved to GitHub Actions through OIDC

Pushing a `v*` tag runs tests, builds, verifies the tag matches `package.json`,
verifies the build did not change a committed artifact, then publishes with the
OIDC credential npm mints for the run. There is no long-lived token.

## What I want reviewed

Be adversarial. In particular:

1. **The reservation.** Can `reserveWorktreeDir` still hand out a duplicate, or
   leak a directory? What happens on a partial failure — say `mkdirSync` succeeds
   on one root and the worktree root differs from the repo root? Is the release
   of a failed reservation (`rmSync`) safe, or can it delete something it should
   not? Is `at` handled sensibly, and does the purpose sanitisation lose
   information that matters?

2. **The main-tree exclusion.** Skipping the first entry of
   `git worktree list --porcelain` assumes the main working tree is first. Is
   that guaranteed across git versions and configurations (bare repo, worktrees
   created with `git worktree add` in either order, `--porcelain` versions)?
   Does `root.repoRoot` remain consistent with the list in every case the code
   reaches? Is there a case where the repo root itself is a linked worktree?

3. **Dual-prefix adoption.** `isCrewWorktreeName` accepts the legacy prefix. Can
   that over-match — adopting a directory that is not Crew's — in the stale list,
   in the cleanup owned check, or anywhere else it is used?

4. **The publish workflow.** Are the guards ordered and scoped correctly? Can the
   artifact guard false-fail or false-pass (it ignores untracked files)? Is the
   version guard bypassable? Is there anything in the workflow that would let a
   publish happen without the tests or build actually running? Is the npm
   version upgrade (`npm install -g npm@^11.5.1`) pinned tightly enough?

5. **Anything else in the diff that looks wrong.** The diff is attached in full;
   the current file contents are attached alongside it.

## Desired output

A prioritized defect list (P0 blocking / P1 should fix / P2 consider), each with
file:line, why it is wrong, and a suggested fix. If an area is clean, say so in
one line. Do not restate the design back to me; give me the criticism.
