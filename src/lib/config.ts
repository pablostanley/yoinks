import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_FILE = path.join(os.homedir(), '.config', 'yoinks', 'config.json')

/** Browsers yt-dlp can read cookies from. */
export const COOKIE_BROWSERS = [
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale',
] as const

export type CookieBrowser = (typeof COOKIE_BROWSERS)[number]

export function isCookieBrowser(value: string): value is CookieBrowser {
  return (COOKIE_BROWSERS as readonly string[]).includes(value)
}

export type Config = {
  /**
   * Browser to borrow cookies from. A browser name pins that one, 'off' means
   * stay signed out, and unset means "figure it out" — see detectCookieBrowser.
   */
  cookiesFrom?: CookieBrowser | 'off'
}

export function loadConfig(): Config {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    const {cookiesFrom} = parsed as {cookiesFrom?: unknown}
    if (cookiesFrom === 'off') return {cookiesFrom: 'off'}
    return typeof cookiesFrom === 'string' && isCookieBrowser(cookiesFrom) ? {cookiesFrom} : {}
  } catch {
    return {}
  }
}

/** Persist settings so `--cookies` only has to be typed once. */
export function saveConfig(config: Config): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), {recursive: true})
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
  } catch {
    // a read-only home shouldn't stop anyone from downloading a video
  }
}
