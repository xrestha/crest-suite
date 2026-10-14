'use strict'
// Starting the helper with Windows: the packed exe is copied to %LOCALAPPDATA%\CrestPrintHelper and
// a small .cmd in the user's Startup folder starts it minimized at sign-in.
const fs = require('node:fs')
const path = require('node:path')

const EXE_NAME = 'CrestPrintHelper.exe'
const CMD_NAME = 'Crest Print Helper.cmd'

function startupPaths(env = process.env, p = path.win32) {
  if (!env.LOCALAPPDATA || !env.APPDATA) return null
  const exeDir = p.join(env.LOCALAPPDATA, 'CrestPrintHelper')
  return {
    exeDir,
    exe: p.join(exeDir, EXE_NAME),
    cmd: p.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', CMD_NAME),
  }
}

// The .cmd names the exe through %LOCALAPPDATA% rather than the expanded path, so a Windows user
// name in Nepali (or any non-ASCII name) cannot break it: cmd.exe reads .cmd files in the OEM code page.
function startupCmd() {
  return `@echo off\r\nrem Starts the Crest Print Helper, minimized, when you sign in to Windows.\r\nstart "" /min "%LOCALAPPDATA%\\CrestPrintHelper\\${EXE_NAME}"\r\n`
}

function startupInstalled(env = process.env, p = path.win32, fsx = fs) {
  const paths = startupPaths(env, p)
  return !!(paths && fsx.existsSync(paths.cmd) && fsx.existsSync(paths.exe))
}

/** Copy the running exe and write the Startup .cmd. Returns the paths; throws on failure. */
function installStartup({ execPath = process.execPath, env = process.env, p = path.win32, fsx = fs } = {}) {
  const paths = startupPaths(env, p)
  if (!paths) throw new Error('LOCALAPPDATA or APPDATA is not set')
  fsx.mkdirSync(paths.exeDir, { recursive: true })
  if (p.resolve(execPath).toLowerCase() !== p.resolve(paths.exe).toLowerCase()) {
    const tmp = `${paths.exe}.new`
    fsx.copyFileSync(execPath, tmp)
    fsx.renameSync(tmp, paths.exe)
  }
  fsx.mkdirSync(p.dirname(paths.cmd), { recursive: true })
  fsx.writeFileSync(paths.cmd, startupCmd())
  return paths
}

module.exports = { startupPaths, startupCmd, startupInstalled, installStartup, EXE_NAME, CMD_NAME }
