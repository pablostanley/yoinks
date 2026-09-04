import {spawn} from 'node:child_process'
import path from 'node:path'

/**
 * Show a finished download in the system file manager. macOS and Windows can
 * highlight the file itself; elsewhere the best we can do is open the folder.
 * Resolves false when there is nothing to open with, so the UI can say so
 * instead of looking like the keypress did nothing.
 */
export function revealInFileManager(filepath: string): Promise<boolean> {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', ['-R', filepath]]
      : process.platform === 'win32'
        ? ['explorer', [`/select,${filepath}`]]
        : ['xdg-open', [path.dirname(filepath)]]

  return new Promise(resolve => {
    let child
    try {
      // detached: the file manager outlives yoinks, and its output must not
      // land in the alternate screen we're drawing on
      child = spawn(command, args, {stdio: 'ignore', detached: true, timeout: 5_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    // explorer.exe exits non-zero even when it worked, so on Windows only a
    // spawn failure counts as failure
    child.on('close', code => resolve(process.platform === 'win32' || code === 0))
    child.unref()
  })
}
