---
title: Releasing
description: 'Publish to npm and GHCR, build the desktop installers, list the app in package managers, and deploy this site.'
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

## The desktop app

The same tag also builds the desktop app (`packaging/desktop`, Electron) on Windows, macOS and
Linux runners. The installers (`.exe`, `.zip`, `.dmg`, `.AppImage`, `.deb`, `.rpm`) and
`SHA256SUMS.txt` are attached to the GitHub release as downloads. `gridcity-desktop` goes to
npm right after `gridcity`. The desktop app ships the exact `gridcity` package from
`release/npm`: it doesn't rebuild or change the app code.

**Betas:** every push to the `feat/desktop-app` branch builds and tests the installers and
publishes them as the next beta (tag `v0.5.0-beta.1`, then `beta.2`, …) on that branch's commit,
as a GitHub pre-release (workflow **Desktop beta**). A beta is never marked as the latest release,
publishes nothing to npm or GHCR, and doesn't touch `main`.

Build and test it locally:

```bash
npm run pack:npm
cd packaging/desktop
npm ci
node build.mjs --stage-only && node test-desktop.mjs   # run it and check it end to end
node build.mjs --win --x64                             # or --mac, --linux: installers in dist/
node test-desktop.mjs --app dist/win-unpacked/GRIDCITY.exe
```

Without signing secrets the builds are unsigned and still work, but macOS Gatekeeper and Windows
SmartScreen warn on first start. To sign, add these repository secrets: `WIN_CSC_LINK` (base64
`.pfx`) and `WIN_CSC_KEY_PASSWORD` for Windows; `MAC_CSC_LINK` (base64 Developer ID `.p12`),
`MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for macOS
signing and notarization.

## Other places to publish

Once a release has its downloads, the app can also be listed in the package managers people
already use. Ready-to-fill manifests are in `packaging/distribution/`. Run
`node packaging/distribution/fill.mjs <version>` after the release to put the version and SHA-256
checksums in them, then submit each one:

| Channel              | Users install with                | Submit to                                                                                                                                               |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| winget (Windows)     | `winget install chapeee.GRIDCITY` | a PR to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) (or `wingetcreate submit`)                                                    |
| Scoop (Windows)      | `scoop install gridcity`          | your own bucket repository, or a PR to [ScoopInstaller/Extras](https://github.com/ScoopInstaller/Extras)                                                |
| Homebrew (macOS)     | `brew install --cask gridcity`    | a tap repository `chapeee/homebrew-tap`, later [homebrew-cask](https://github.com/Homebrew/homebrew-cask)                                               |
| AUR (Arch Linux)     | `yay -S gridcity-bin`             | the [AUR](https://aur.archlinux.org/) as `gridcity-bin`                                                                                                 |
| Flathub / Snap Store | Linux software centers            | [Flathub](https://docs.flathub.org/docs/for-app-authors/submission) (needs a Flatpak manifest), [snapcraft.io](https://snapcraft.io/docs/electron-apps) |
| MCP Registry         | MCP clients                       | `server.json` (already in the repo)                                                                                                                     |

To spread the word: [AlternativeTo](https://alternativeto.net/), [Product Hunt](https://www.producthunt.com/),
[awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted),
[awesome-sysadmin](https://github.com/awesome-foss/awesome-sysadmin), the
[awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) lists, Show HN, and
r/selfhosted and r/homelab.

## The documentation site

The **Docs** workflow builds `website/` and deploys it to GitHub Pages on every push to `main` that
touches it (enable Pages with "GitHub Actions" as the source in the repository settings). For a
custom domain, set `DOCS_URL` and `DOCS_BASE_URL` in the workflow and add a `CNAME` file to
`website/static/`.
