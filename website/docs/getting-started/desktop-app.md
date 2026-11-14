---
title: Desktop app
description: 'GRIDCITY in its own window with Chromium built in: installers for Windows, macOS and Linux, or npx gridcity-desktop.'
---

# Desktop app

The desktop app is GRIDCITY in its own window, with Chromium built in (it is made with
[Electron](https://www.electronjs.org/)). There's no browser tab and no terminal to keep open,
and you don't need Node.js.

## Download

Get the installer for your system from the
[latest GitHub release](https://github.com/chapeee/GRIDCITY/releases/latest):

| System  | File                                                                           |
| ------- | ------------------------------------------------------------------------------ |
| Windows | `GRIDCITY-<version>-win-x64.exe` (installer), `-arm64.exe`, `.zip` (portable)  |
| macOS   | `GRIDCITY-<version>-mac-arm64.dmg` (Apple Silicon), `-mac-x64.dmg` (Intel)     |
| Linux   | `.AppImage` (any distribution), `.deb` (Debian, Ubuntu), `.rpm` (Fedora, RHEL) |

Each release also lists `SHA256SUMS.txt`, so you can check the download.

Or start it from npm, which downloads Electron for you:

```bash
npx gridcity-desktop
```

([gridcity-desktop on npm](https://www.npmjs.com/package/gridcity-desktop))

:::note First start on macOS and Windows
Until the builds are signed, your system will warn you the first time:

- **macOS:** open GRIDCITY once (macOS refuses), then go to **System Settings → Privacy &
  Security** and click **Open Anyway**. You only do this once. Or run
  `xattr -cr /Applications/GRIDCITY.app` in Terminal.
- **Windows:** in the SmartScreen dialog, choose **More info**, then **Run anyway**. Windows 11
  with **Smart App Control** turned on blocks unsigned apps completely, with no way to allow
  them. There, use `npx gridcity-desktop` (it runs Electron's own signed binary) or
  [`npx gridcity`](./installation.md#npm) until the installer is signed.
- **Linux AppImage:** make it executable first (`chmod +x GRIDCITY-*.AppImage`).

:::

## How it works

The desktop app runs the **same server** as the [`gridcity`](https://www.npmjs.com/package/gridcity)
command and opens it in a window:

- It shares the [data and settings folders](./installation.md#where-your-data-lives) with the
  npm command: the same servers, history, alerts and saved credentials. You can use either, or
  both.
- If GRIDCITY is already running (started with `gridcity` in a terminal), the window opens that
  server instead of starting a second one. If that server runs an older version, the app
  restarts it on its own version.
- **Closing the window** keeps GRIDCITY in the system tray, still watching your servers and
  sending alerts.
- The tray menu has **Open in browser**, **Switch to the demo city**, **Open data folder**,
  **Start at login**, **Quit** (the server keeps
  monitoring in the background, as with `gridcity`) and **Stop GRIDCITY and quit**.
- The server listens on `127.0.0.1:4600` only, as always. Links to other sites open in your
  normal browser.

## Start at login

The installed app turns on **Start at login** the first time it runs, so monitoring and alerts
come back after the computer restarts. When you sign in, GRIDCITY starts the server and waits in
the tray (the menu bar on macOS) without opening a window. Click the tray icon to open it.

To turn it off, untick **Start at login** in the tray menu. On Windows and macOS it's a login
item (Windows: **Settings → Apps → Startup**); on Linux it's
`~/.config/autostart/gridcity.desktop`. Uninstalling on Windows removes it. `npx gridcity-desktop`
doesn't offer it, because its Electron lives in npm's cache.

On GNOME without the AppIndicator extension there is no tray icon. The server still starts at
login; open GRIDCITY from the app menu to see the window.

## Updating

When a new version is out, GRIDCITY says so at the bottom left of the window, with a link to
what's new. Install the new version over the old one, or run `npx gridcity-desktop@latest`. Your data stays
where it is: updates never touch the data folder, and the database upgrades itself on start.

## Uninstalling

Uninstalling the app leaves your data. To remove that too, delete the data and config folders
listed in [Where your data lives](./installation.md#where-your-data-lives).
