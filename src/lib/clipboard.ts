import {execFileSync} from 'node:child_process'

const COMMANDS: Array<[string, string[]]> =
  process.platform === 'darwin'
    ? [['pbpaste', []]]
    : process.platform === 'win32'
      ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
      : [
          ['wl-paste', ['--no-newline']],
          ['xclip', ['-selection', 'clipboard', '-o']],
          ['xsel', ['--clipboard', '--output']],
        ]

export function readClipboard(): string {
  for (const [command, args] of COMMANDS) {
    try {
      return execFileSync(command, args, {encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore']})
    } catch {
      // tool missing or clipboard empty — try the next one
    }
  }
  return ''
}

/**
 * Put the downloaded file itself on the clipboard (not its path) so it can be
 * pasted into a file manager. Best-effort — returns false when no supported
 * tool is available. Linux copies a file:// uri, the closest portable analog.
 */
export function copyFileToClipboard(filepath: string): boolean {
  try {
    if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', `set the clipboard to (POSIX file ${JSON.stringify(filepath)})`], {
        timeout: 2000,
        stdio: 'ignore',
      })
      return true
    }
    if (process.platform === 'win32') {
      // -LiteralPath so wildcard-looking names aren't glob-expanded; single
      // quotes with doubled inner quotes are PowerShell's literal escape
      const literal = `'${filepath.replace(/'/g, "''")}'`
      execFileSync('powershell', ['-NoProfile', '-Command', `Set-Clipboard -LiteralPath ${literal}`], {
        timeout: 2000,
        stdio: 'ignore',
      })
      return true
    }
    const uri = `file://${filepath}`
    for (const [command, args] of [
      ['wl-copy', ['--type', 'text/uri-list']],
      ['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list']],
    ] as const) {
      try {
        execFileSync(command, args, {input: uri, timeout: 2000, stdio: ['pipe', 'ignore', 'ignore']})
        return true
      } catch {
        // tool missing — try the next one
      }
    }
    return false
  } catch {
    return false
  }
}
