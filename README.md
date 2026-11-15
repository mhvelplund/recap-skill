# recap-skill

_Old age took your memory? This skill tells you what you were doing._

## Prerequisites

A reasonably new version of Node.js (with `npx`). The collector script runs on [zx](https://github.com/google/zx), which
the skill fetches automatically via `npx` on first run — no global install needed.

## Installation

Install with [`npx skills`](https://github.com/vercel-labs/skills):

```shell
npx skills add mhvelplund/recap-skill -g -a claude-code
```

`-g` installs for your user (`~/.claude/skills/recap`). Drop it to install into the current project instead
(`.claude/skills/recap`). Keep it current with `npx skills update`, and uninstall with `npx skills remove recap`.

## Configuration

The skill needs to know where your git repositories live. Set `RECAP_GIT_HOME` to that directory — there is no default,
and the skill will stop and ask you to set it if it is missing:

```shell
echo 'export RECAP_GIT_HOME="$HOME/projects"' >> ~/.profile  # or ~/.bash_profile
```

What gets scanned:

- every git repo directly under `$RECAP_GIT_HOME`,
- every git repo one level below that, so `projects/some-org/some-repo` is found too,
- plus any repo your Claude sessions touched during the window, even if it lives outside `$RECAP_GIT_HOME`.

If `RECAP_GIT_HOME` is unset, or points at a directory that does not exist, the collector exits with an error and the
skill tells you to fix it instead of producing a half-empty recap.

## Usage

Start Claude and write `What did I do yesterday?` or `/recap last week`.
