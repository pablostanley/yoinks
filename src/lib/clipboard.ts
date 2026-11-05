import {execFile} from 'node:child_process'

const COMMANDS: Array<[string, string[]]> =
  process.platform === 'darwin'
    ? [['pbpaste', []]]
    : process.platform === 'win32'
      ? [['powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard']]]
      : [
          ['wl-paste', ['--no-newline']],
          ['xclip', ['-selection', 'clipboard', '-o']],
          ['xsel', ['--clipboard', '--output']],
        ]

// powershell alone can take over a second to start, so this is async with a generous timeout
const TIMEOUT_MS = 4000

function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(command, args, {encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true}, (error, stdout) =>
      resolve(error ? undefined : stdout),
    )
  })
}

export async function readClipboard(): Promise<string> {
  for (const [command, args] of COMMANDS) {
    const text = await run(command, args)
    if (text !== undefined) return text
  }
  return ''
}
