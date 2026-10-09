# Installing this skill

The **canonical copy lives here, in the vault**, so it is versioned with git.

It is also installed at `~/.claude/skills/jev-scoring/` so every project picks
it up, not just this one. That copy is a **derived artifact** - edit the vault
copy, then re-install. Never edit both.

## Install / update

```bash
SRC="<repo>/Agent/Orchestrator/.claude/skills/jev-scoring"
DST="<machine-path>/.claude/skills/jev-scoring"
mkdir -p "$DST"
cp "$SRC/SKILL.md" "$SRC/baseline-evidence.md" "$DST/"
```

## Check for drift

```bash
for f in SKILL.md baseline-evidence.md; do
  a=$(md5sum "$SRC/$f" | cut -d' ' -f1); b=$(md5sum "$DST/$f" | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "MATCH $f" || echo "DRIFT $f"
done
```

## Why two locations

`~/.claude/skills/` is the only path that makes the skill available everywhere,
and it is outside git. The vault gives versioning and portability (v2 goal:
extract the fleet to its own repo). Installed 2026-10-03; both copies verified
byte-identical at install time.
