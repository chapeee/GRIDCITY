#!/usr/bin/env node
// `npx gridcity-desktop`: opens the GRIDCITY desktop window with the Electron
// that npm installed next to this package. The terminal is free right away.
'use strict';

const { spawn } = require('node:child_process');
const { join } = require('node:path');

const electron = require('electron'); // the path to the Electron binary
const child = spawn(electron, [join(__dirname, '..')], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
});
child.unref();
process.stdout.write(
  '  GRIDCITY is opening in its own window.\n' +
    '  Closing the window keeps it in the tray, still watching your servers.\n',
);
