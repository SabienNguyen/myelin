# Vendored: Hallmark

Third-party skill, copied in unmodified. Not our code — do not edit `SKILL.md` or `references/`.
Local design decisions belong in `/design.md` at the repo root, which Hallmark's pre-flight reads
first and treats as the locked system.

| | |
| --- | --- |
| Upstream | https://github.com/Nutlope/hallmark |
| Version | 1.1.0 (`SKILL.md` frontmatter) |
| Commit | `aeb42fb` ("Merge pull request #18 from Nutlope/fix/existing-stylesheet-merge") |
| Vendored | 2026-07-25 |
| License | MIT — see `LICENSE` |
| Size | 107 files, ~964K (all markdown) |

## Why vendored instead of `npx skills add`

`npx skills add nutlope/hallmark` installs to `~/.claude/skills/`, which is per-machine and
uncommitted. Vendoring here means every clone and every agent session gets the same rule-set without
a setup step.

## Updating

```bash
git clone --depth 1 https://github.com/Nutlope/hallmark.git /tmp/hallmark
rm -rf .claude/skills/hallmark/{SKILL.md,references}
cp -r /tmp/hallmark/skills/hallmark/. .claude/skills/hallmark/
cp /tmp/hallmark/LICENSE .claude/skills/hallmark/LICENSE
```

Then re-read `/design.md` against the new `SKILL.md` § "Pre-flight scan" — upstream can change the
signal sources it looks for, and `design.md` is only authoritative if Hallmark still reads it first.
Update the table above with the new version and commit.

## How it composes with this repo's own skills

- **`hallmark`** (this) — general design rule-set: macrostructure, themes, 57 slop-test gates, and
  the `audit` / `redesign` / `study` verbs. Written for greenfield pages.
- **`no-slop-ui`** — this app's specific design language and structural seams. Narrower and more
  authoritative for anything already built.
- **`design.md`** (repo root) — the machine-readable contract between the two. Hallmark reads it in
  Step 0 and defers to it instead of picking a theme.

On an existing surface, `no-slop-ui` and `design.md` win. Hallmark's value here is `audit` (score a
diff against the anti-pattern list), `study` (extract design DNA from a reference), and its
slop-test gates on genuinely new surfaces.
