import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SETTINGS_FILE = path.join(os.homedir(), '.config', 'yoinks', 'settings.json')

export type Settings = {
  ytdlpArgs: string
}

export const DEFAULT_SETTINGS: Settings = {ytdlpArgs: ''}

export function loadSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'ytdlpArgs' in parsed) {
      const {ytdlpArgs} = parsed as {ytdlpArgs?: unknown}
      if (typeof ytdlpArgs === 'string') return {ytdlpArgs}
    }
  } catch {
    // Missing or invalid settings fall back to the stock yt-dlp invocation.
  }
  return {...DEFAULT_SETTINGS}
}

export function saveSettings(settings: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), {recursive: true})
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`)
}
