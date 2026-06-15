## Private docs

Architecture notes, protocol mapping, loom scripts, internal design memos —
anything not intended for the public `README.md` — belong in **`private-docs/`**.
That directory is gitignored on purpose. The public-facing surface is `README.md`
plus per-package READMEs only.

Rules:

- **Architecture / design / internal-process docs → `private-docs/<NAME>.md`.**
  Never put them in the repo root or in a top-level `docs/` folder. A `docs/`
  folder would be public; `private-docs/` is not.
- **Don't link to `private-docs/` from `README.md` or any other tracked file.**
  Public consumers won't have those files when they clone the repo; the links
  would 404.
- **GOAL.md, VISION.md, AGENTS.md** are also gitignored brief / planning
  surfaces. Same discipline: anything you wouldn't want public goes in one of
  these or in `private-docs/`.
- If a private doc grows up and becomes truly public-ready, **move it out of
  `private-docs/`** explicitly (e.g. into a top-level `ARCHITECTURE.md` at the
  repo root, or into a package's own README) — and only then.

## Release documentation

Every shipped release (every GOAL.md execution that lands on `main`, including
patch releases like v0.4.1) must update two files as part of the release's
integration commit:

- **`CHANGELOG.md`** at the repo root — Keep-a-Changelog format
  (https://keepachangelog.com). One H2 section per release titled
  `## [<version>] - <YYYY-MM-DD>`, with H3 subsections in this order:
  `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`,
  `### Security`. Include only subsections that have entries. Each bullet
  references the criterion IDs from the release's GOAL.md when applicable
  (e.g. `Fixed: UCP capability map uses canonical full-key form (CK1, CK4)`).

- **`docs/releases.md`** — narrative release notes (1-2 paragraphs per
  release) wired into `mkdocs.yml` nav. Each entry mirrors the GitHub
  Release body so the published docs site shows the release timeline
  alongside the protocol reference.

Rules:

- **Update lands on the integration commit, not at tag time.** Reviewers
  see the changelog entry alongside the code change. The user (not the
  agent) creates the git tag separately per Guardrail #10.
- **Every GOAL.md's IN (Integration) category must list a criterion** for
  updating both files with the release's entry. No exception for patch
  releases.
- **Past entries are immutable.** Each new release adds a section at the
  top of both files. Bugs in past entries get a follow-up release with a
  `Fixed:` note that points at the original entry, not an edit of it.
- **Both files are public.** No references to `private-docs/`, no
  internal-incident detail, nothing not in the released surface.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
