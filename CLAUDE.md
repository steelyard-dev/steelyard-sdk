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
