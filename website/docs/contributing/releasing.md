---
title: Releasing
description: 'Publish to npm and GHCR, and deploy this site.'
---

# Releasing

1. Update the version in the root `package.json` (and the workspace packages) and add a section to
   `CHANGELOG.md`.
2. Commit, then tag and push:

```bash
git tag v0.2.0
git push origin main --tags
```

The **Release** workflow then checks everything, publishes `gridcity` to npm with provenance,
pushes `ghcr.io/chapeee/gridcity:<version>` and `:latest` for amd64 and arm64, and creates the
GitHub release from the changelog.

It needs one repository secret, `NPM_TOKEN` (an npm automation token). Users never need a token:
it only lets npm accept new versions from the owner. To publish by hand instead:

```bash
npm login
npm run pack:npm
cd release/npm && npm publish --access public
```

## The documentation site

The **Docs** workflow builds `website/` and deploys it to GitHub Pages on every push to `main` that
touches it (enable Pages with "GitHub Actions" as the source in the repository settings). For a
custom domain, set `DOCS_URL` and `DOCS_BASE_URL` in the workflow and add a `CNAME` file to
`website/static/`.
