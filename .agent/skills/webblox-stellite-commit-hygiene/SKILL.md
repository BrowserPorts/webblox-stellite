---
name: webblox-stellite-commit-hygiene
description: Inspect and protect Git boundaries before branch, staging, commit, history rewrite, push, or PR work in webblox-stellite, Stellite's copy of WebBlox. Use for reviewing dirty trees, separating other sessions' changes, keeping Roblox sessions, game caches and captures out of public history, or preparing any Git mutation. Commit completed changes frequently under standing authorization. Pushing, rewriting history and changing branches need separate authorization.
---

# Keep webblox-stellite history clean

Load this skill before any Git mutation beyond read-only inspection.

## Inspect first

Run in the webblox-stellite Git root (`webblox-stellite/`):

```sh
git status --short --branch
git remote -v
git diff --stat
git diff --cached --stat
git diff --cached
```

Classify pre-existing work and current-task changes. Never stage unrelated files, discard another session's work, reset another process's changes, or bypass hooks.

Split mixed dirty trees. One commit is one product change: the server, the player, the launcher, an engine patch or a tool each go alone.

## Commit authorization and cadence

Commit your own completed feature or fix slices frequently after their relevant checks pass. A change a player sees is run in a browser through `npm start` before it is committed. This is standing authorization from the owner: do not ask before routine commits and do not defer all commits to the end of a long task.

Commit only your own changes. Authorization to commit never authorizes pushing, creating or switching branches, publishing, amending, or rewriting history. Each needs separate authorization unless the session already provides it.

## Remotes and branches

| Remote | Address | Use |
| --- | --- | --- |
| `origin` | `https://browserports.dev/BrowserPorts/webblox-stellite.git` | Forgejo. The only push target. |

- `main` is the only branch. Use `codex/<topic>` only when a branch is requested.
- This repository is public. Forgejo pushes it to the read-only mirror at `github.com/BrowserPorts/webblox-stellite`. Reach GitHub only through that mirror: never push to GitHub directly and never add a GitHub push remote.
- WebBlox was imported as downloaded in the first commit and has no upstream remote. A newer WebBlox drop is taken as its own commit, apart from Stellite's changes.

## Staging

Inspect every untracked path. Never stage:

- `.roblosecurity` or any other Roblox cookie, account name or session token
- `.cache/`, `game-cache/`, `.chrome-test/`, `.freebuff/`, `node_modules/`
- `*.log`, `*.pcapng`, `*.etl`, and other captures or traces
- downloaded places, assets or packages from a real session

`public/engine/` and `public/gen/` are tracked output of the repository's own tools (`npm run patch`, `update-engine`, `build-wgsl`, `port-shaders`). Change them through those tools and commit their output with the change that caused it, never edited by hand.

`.claude/` is ignored in the tracked `.gitignore`. Only this skill's discovery link is tracked there; stage a new file under it with `git add -f -- <exact path>` only when it is a skill meant for every clone.

Stage exact paths, then rerun status and inspect the complete staged diff. Unstage a prohibited path with `git restore --staged -- <path>`; do not discard its working copy.

## Commit messages

Use Conventional Commits:

```text
<type>(<scope>): <imperative technical summary>
```

- Keep the subject at or below 72 characters.
- Describe product behavior and technical rationale only.
- Use the configured human author and committer.
- No AI or model attribution of any kind: no `Co-Authored-By` naming Claude or Anthropic, no `noreply@anthropic.com`, no `Claude-Session` line, no generated-by line. Nothing on the server checks this, so the agent making the commit is responsible for keeping it out.
- No sessions, prompts, task or rule numbers, agents, waves, worktrees, workflows, checkpoints, plans, transcripts, or process narration.

Scan the exact proposed message before committing:

```sh
rg -ni 'co-authored-by:.*(claude|anthropic|ai)|claude-session|assisted-by|generated(-by| with)|task ?#|rule ?#|#[0-9]|iter-|wave|refuter|worktree|workflow|goal-mode|checkpoint|transcript'
```

No matches are permitted.

## Pushing

- Push only to `origin` on Forgejo, and only when authorized. `git remote get-url --push origin` must print the Forgejo URL. Never push to Cursor's origin (`origin.cursor.com`) or to GitHub.
- Push one branch with an explicit refspec: `git push origin main:main`. Never `--force`, `--all`, `--mirror`, or a bare `git push`.
- Before every push, scan the whole outgoing range, including commits already ahead of the remote, and stop if anything matches:

```sh
git log --format='%H%n%B' origin/main..HEAD | rg -ni 'co-authored-by:.*(claude|anthropic)|noreply@anthropic\.com|claude-session|generated(-by| with)'
```

- If Forgejo refuses a push, report why. Do not rewrite history to get around it.

## Safeguards

- Never use `--no-verify`.
- Never amend a pushed commit, force-push, or rewrite shared history without explicit approval.
- Reinspect `git show --stat --oneline --decorate HEAD` and status after every commit.
