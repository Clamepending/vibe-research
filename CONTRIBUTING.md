# Contributing

Thanks for helping make Vibe Research sturdier. The project is still young, so
small focused changes are much easier to review than broad rewrites.

## Before Opening A PR

1. Start from the latest `main`.
2. Keep the change focused on one behavior or documentation area.
3. Avoid committing generated runtime state such as `.vibe-research/`,
   `.remote-vibes/`, `.playwright-cli/`, `output/`, or `node_modules/`.
4. Run the checks that fit your change:

```bash
npm test
npm run build
git diff --check
```

## Security-Sensitive Areas

Please call out changes that affect:

- install or update behavior
- release scripts or GitHub Actions
- file browsing or file writing
- session creation, websockets, or terminal input
- local port proxying
- provider credentials or saved secrets
- BuildingHub catalog loading

Security issues that could affect users should follow `SECURITY.md` instead of
a public issue.

## Release Discipline

Stable installs follow GitHub Releases, not arbitrary `main` commits. The
release workflow runs tests before publishing a release. Do not move published
`v*` tags.

## BuildingHub

Community BuildingHub entries should stay manifest-only. They may describe
setup steps, helper commands, MCP names, documentation links, and required
environment variable names. They must not hide executable code, shell pipelines,
or secrets inside catalog manifests.
