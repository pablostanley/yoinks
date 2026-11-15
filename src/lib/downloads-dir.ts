import {execFile} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

// the shell's own answer, so a Downloads folder moved to another drive
// (Properties → Location) or redirected by policy is followed
const WINDOWS_LOOKUP = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path",
].join('; ')

const LOOKUPS: Array<[string, string[]]> =
  process.platform === 'win32'
    ? [['powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LOOKUP]]]
    : process.platform === 'linux'
      ? [['xdg-user-dir', ['DOWNLOAD']]]
      : [] // macOS can't relocate ~/Downloads

// async on purpose — a sync spawn freezes ink mid-frame (see lib/ytdlp.ts)
function ask(command: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    try {
      execFile(command, args, {encoding: 'utf8', timeout: 5_000, windowsHide: true}, (error, stdout) =>
        resolve(error ? '' : stdout),
      )
    } catch {
      resolve('')
    }
  })
}

/**
 * Turn what the system reported into a folder to save to. Anything unusable
 * falls back to ~/Downloads: no answer, a relative path, or the home folder
 * itself — which is what xdg-user-dir prints when no Downloads dir is set.
 */
export function pickDownloadsDir(reported: string, homedir: string): string {
  const dir = reported.split(/\r?\n/)[0]!.trim()
  if (!dir || !path.isAbsolute(dir) || path.relative(dir, homedir) === '') return path.join(homedir, 'Downloads')
  return path.normalize(dir)
}

let lookup: Promise<string> | undefined

/** The user's real Downloads folder, which is not always ~/Downloads. Looked up once. */
export function findDownloadsDir(): Promise<string> {
  lookup ??= (async () => {
    let reported = ''
    for (const [command, args] of LOOKUPS) {
      reported = await ask(command, args)
      if (reported.trim()) break
    }
    return pickDownloadsDir(reported, os.homedir())
  })()
  return lookup
}
