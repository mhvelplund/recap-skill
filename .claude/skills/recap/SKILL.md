---
name: recap
description:
  Terse table of what the user worked on since the last working day — repo, branch, PR, description. Use for
  "recap", "what was I doing", "what did I work on yesterday".
argument-hint: "[24h|48h|friday]"
allowed-tools: Bash(zx:*), Bash(mkdir:*), Write
---

# Recap

Reconstruct what the user was working on, for the 10:00 recap. They will invoke this from a random repo, a random
branch, or no repo at all — **the current directory is irrelevant and must never influence the report**. The collector
discovers everything itself.

## 1. Collect

```bash
~/.claude/skills/recap/collect.ts --since "${0:-workday}"
```

`--since` accepts `workday` (default — back to 10:00 of the previous working day, so Monday reaches Friday), a duration
(`24h`, `48h`, `3d`), a weekday name (`friday`), or an ISO timestamp.

The collector scans the directory named by the **`RECAP_GIT_HOME`** environment variable for git repos. It is required
and has no default. If the collector exits non-zero it prints one JSON object on stderr with an `error` field — handle
these two and **stop**: no table, no partial report, no fallback scan of your own.

- `RECAP_GIT_HOME_NOT_SET` — tell the user to set `RECAP_GIT_HOME` to the directory holding their git repositories and
  re-run, e.g. add `export RECAP_GIT_HOME="$HOME/projects"` to `~/.zshrc` (or `~/.bashrc`).
- `RECAP_GIT_HOME_INVALID` — report the path it named; the directory does not exist, so it is a typo or a stale config.

**Never read `~/.claude/projects/**/*.jsonl` or `~/.claude/history.jsonl` yourself.** One day of sessions is ~6.7 MB
(~1.7M tokens) and will blow the context window. The collector streams them and returns ~10 KB of facts. If `zx` is
missing, say so and stop — do not improvise a shell equivalent.

## 2. Build the table

One row per `(repo, branch)`, in the order the collector returns them (already ranked by signal strength):

| time | repo | branch | pr  | description |
| ---- | ---- | ------ | --- | ----------- |

- **time** — `row.time`, verbatim. It is `dd/mm` when the window spans more than 24h and `hh:mm` (rounded to the
  nearest half hour) when it is 24h or less. Render it as-is; do not reformat or recompute it. Blank means no dated
  evidence — leave the cell empty.
- **pr** — `[#11868](url)` from `row.pr`, or empty. Append the state only when it is not `open`, e.g. `[#11868](url)
merged`.
- **description** — ≤ ~12 words, past tense. Merge `session_titles` (model-written summaries of what was actually being
  worked on) with `commits[].subject`. Prefer a session `recap` when one exists. **Invent nothing** that is not in the
  JSON.
- Prefix uncommitted work with `WIP:` and mention the file count.
- A row with `commit_count: 0` but a title or WIP is still real work — include it.

## 3. Rules that matter

- **`rebased` is not work.** Those commits were authored before the window and only re-committed inside it by a rebase.
  Never describe them as things the user did. If any row has `rebased > 0`, add one line under the table noting the
  count, nothing more.
- **Report the window** the collector resolved (`window.label`) above the table, so the user knows what they are
  looking at — especially on a Monday.
- **Surface `notes` verbatim** when non-empty. If it contains `gh unavailable`, say the pr column is incomplete rather
  than letting empty cells imply "no PR".
- Do not pad the table with repos the collector omitted; it already dropped everything without signal.

## 4. Deliver

Print the table in the response, then save the same content:

```bash
mkdir -p ~/recap
```

Write it to `~/recap/<YYYY-MM-DD>.md` with the window label as an H1. Use the `Write` tool.

Close with a single line — **"Left off:"** — describing where the user stopped, taken from the most recent session's
`recap` or `last_prompt`. That is the half of recap that answers "what's next".
