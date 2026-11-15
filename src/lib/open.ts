import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

export type OpenCommand = {
  command: string
  args: string[]
  /** hand the args to the program exactly as written (windows only) */
  verbatim?: boolean
  /** the exit code says nothing about success */
  ignoreExit?: boolean
}

// explorer.exe splits its command line on commas, so the path has to be
// quoted even when it has no spaces — node only quotes args with spaces,
// hence verbatim. Windows file names can't contain a quote themselves.
// It also exits 1 on success, so its exit code is ignored.
const explorer = (arg: string): OpenCommand => ({
  command: 'explorer.exe',
  args: [arg],
  verbatim: true,
  ignoreExit: true,
})

/** Open a file in whatever app the system uses for it. */
export function openFileCommand(filepath: string, platform: NodeJS.Platform = process.platform): OpenCommand {
  if (platform === 'win32') return explorer(`"${path.win32.normalize(filepath)}"`)
  if (platform === 'darwin') return {command: 'open', args: [filepath]}
  return {command: 'xdg-open', args: [filepath]}
}

/**
 * Show a file in the system file manager, selected. Commands are tried in
 * order until one works — linux has no single way to select a file, so it
 * falls back to just opening the folder.
 */
export function revealFileCommands(filepath: string, platform: NodeJS.Platform = process.platform): OpenCommand[] {
  if (platform === 'win32') return [explorer(`/select,"${path.win32.normalize(filepath)}"`)]
  if (platform === 'darwin') return [{command: 'open', args: ['-R', filepath]}]
  return [
    {
      command: 'dbus-send',
      args: [
        '--session',
        '--print-reply',
        '--dest=org.freedesktop.FileManager1',
        '--type=method_call',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1.ShowItems',
        // dbus-send splits array values on commas
        `array:string:${pathToFileURL(filepath).href.replaceAll(',', '%2C')}`,
        'string:',
      ],
    },
    {command: 'xdg-open', args: [path.dirname(filepath)]},
  ]
}

function run({command, args, verbatim, ignoreExit}: OpenCommand): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, {
        stdio: 'ignore',
        windowsVerbatimArguments: verbatim,
        // the opened app should outlive yoinks
        detached: process.platform !== 'win32',
      })
    } catch {
      resolve(false)
      return
    }
    child.unref()
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(ignoreExit || code === 0))
  })
}

async function exists(filepath: string): Promise<boolean> {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

/** Resolves false when the file is gone or nothing could open it. */
export async function openFile(filepath: string): Promise<boolean> {
  return (await exists(filepath)) && run(openFileCommand(filepath))
}

/** Resolves false when the file is gone or no file manager could show it. */
export async function revealFile(filepath: string): Promise<boolean> {
  if (!(await exists(filepath))) return false
  for (const command of revealFileCommands(filepath)) {
    if (await run(command)) return true
  }
  return false
}
