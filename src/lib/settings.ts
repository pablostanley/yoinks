import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SETTINGS_FILE = path.join(os.homedir(), '.config', 'yoinks', 'settings.json')

export type Settings = {
  copyToClipboard: boolean
}

const DEFAULTS: Settings = {
  copyToClipboard: false,
}

export function loadSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof (parsed as Settings).copyToClipboard === 'boolean') {
      return {...DEFAULTS, copyToClipboard: (parsed as Settings).copyToClipboard}
    }
  } catch {
    // no settings yet, or unreadable — fall back to defaults
  }
  return {...DEFAULTS}
}

/** Persist settings. Returns the value written so callers can update state. */
export function saveSettings(settings: Settings): Settings {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), {recursive: true})
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`)
  } catch {
    // settings are a nicety — never let it break the app
  }
  return settings
}
