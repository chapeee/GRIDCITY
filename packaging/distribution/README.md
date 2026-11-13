# Package-manager manifests

Templates for listing the desktop app in winget, Scoop, Homebrew and the AUR. After a release
has its downloads:

```bash
node packaging/distribution/fill.mjs <version>
```

This writes the filled files to `release/distribution/`. Where to submit each one is in
[Releasing](../../website/docs/contributing/releasing.md#other-places-to-publish).
