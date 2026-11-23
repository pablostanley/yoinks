import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * ~/Downloads by default. On Linux, honour the XDG user directory
 * (e.g. ~/Téléchargements on a French system) when it is configured.
 */
export function getDownloadDir(): string {
  const home = os.homedir()
  const fallback = path.join(home, 'Downloads')
  if (process.platform !== 'linux') return fallback
  try {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
    const file = fs.readFileSync(path.join(configHome, 'user-dirs.dirs'), 'utf8')
    const match = /^XDG_DOWNLOAD_DIR="?([^"\n]+)"?/m.exec(file)
    if (!match) return fallback
    const dir = match[1].replace(/^\$HOME(?=\/|$)/, home)
    return path.isAbsolute(dir) ? dir : fallback
  } catch {
    return fallback
  }
}
