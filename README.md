# recap-skill

_Old age took your memory? This skill tells you what you were doing._

## Prerequisites

You need a reasonably new version of Node.js and Google/zx. The latter can be installed from NPM:

```shell
npm install -g zx
```

## Installation

Copy the skill to your `.claude` dir:

```shell
mkdir -p ~/.claude/skills/
cp -a .claude/skills/recap ~/.claude/skills/.
```

Start Claude and write `What did I do yesterday?` or `/recap last week`.
