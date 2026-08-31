# recap-skill

_Old age took your memory? This skill tells you what you were doing._

## Prerequisites

You need a reasonably new version of Node.js and Google/zx. The latter can be installed from NPM:

```shell
npm install -g zx
```

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

## Installation

Copy the skill to your `.claude` dir:

```shell
mkdir -p ~/.claude/skills/
cp -a .claude/skills/recap ~/.claude/skills/.
```

Start Claude and write `What did I do yesterday?` or `/recap last week`.
