import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {CookieBrowser} from './config.js'
import {detectPlatform} from './platforms.js'

/**
 * Where each browser keeps its profile, per platform. Presence of the folder
 * is enough — yt-dlp does the real cookie reading, and asking it to try a
 * browser that isn't installed just wastes a spawn.
 *
 * Order matters: it is the order we try them in. Firefox leads because
 * Chromium browsers encrypt their cookie store on macOS and Windows, where
 * reading it often fails. Safari is deliberately absent — touching its
 * cookies raises a system permission prompt nobody asked for.
 */
function profileCandidates(): Array<[CookieBrowser, string[]]> {
  const home = os.homedir()
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')

  if (process.platform === 'win32') {
    return [
      ['firefox', [path.join(appData, 'Mozilla', 'Firefox')]],
      ['brave', [path.join(localAppData, 'BraveSoftware', 'Brave-Browser')]],
      ['chrome', [path.join(localAppData, 'Google', 'Chrome')]],
      ['chromium', [path.join(localAppData, 'Chromium')]],
      ['edge', [path.join(localAppData, 'Microsoft', 'Edge')]],
      ['vivaldi', [path.join(localAppData, 'Vivaldi')]],
      ['opera', [path.join(appData, 'Opera Software', 'Opera Stable')]],
    ]
  }

  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support')
    return [
      ['firefox', [path.join(support, 'Firefox')]],
      ['brave', [path.join(support, 'BraveSoftware', 'Brave-Browser')]],
      ['chrome', [path.join(support, 'Google', 'Chrome')]],
      ['chromium', [path.join(support, 'Chromium')]],
      ['edge', [path.join(support, 'Microsoft Edge')]],
      ['vivaldi', [path.join(support, 'Vivaldi')]],
      ['opera', [path.join(support, 'com.operasoftware.Opera')]],
    ]
  }

  const config = path.join(home, '.config')
  return [
    // snap and flatpak keep their own copies of the profile
    [
      'firefox',
      [
        path.join(home, '.mozilla', 'firefox'),
        path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
        path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
      ],
    ],
    ['brave', [path.join(config, 'BraveSoftware', 'Brave-Browser')]],
    ['chrome', [path.join(config, 'google-chrome')]],
    ['chromium', [path.join(config, 'chromium'), path.join(home, 'snap', 'chromium', 'common', 'chromium')]],
    ['edge', [path.join(config, 'microsoft-edge')]],
    ['vivaldi', [path.join(config, 'vivaldi')]],
    ['opera', [path.join(config, 'opera')]],
  ]
}

/**
 * The cookies we actually hand yt-dlp for one link.
 *
 * YouTube is the exception. It rotates the cookies of a signed-in session
 * constantly, so the jar of a running browser is usually stale by the time
 * yt-dlp reads it, and the player answers “The page needs to be reloaded”
 * for a video that downloads fine signed out. yt-dlp warns against feeding
 * it YouTube account cookies for that reason too. So a browser *we* guessed
 * stays out of YouTube's way, while a browser pinned with --cookies is still
 * used — that one is a deliberate choice for links that need an account.
 */
export function cookiesForUrl(
  cookiesFrom: string | undefined,
  guessed: boolean | undefined,
  url: string,
): string | undefined {
  if (!cookiesFrom) return undefined
  return guessed && detectPlatform(url).key === 'youtube' ? undefined : cookiesFrom
}

/** First installed browser we can borrow cookies from, if any. */
export function detectCookieBrowser(exists: (dir: string) => boolean = fs.existsSync): CookieBrowser | undefined {
  for (const [browser, dirs] of profileCandidates()) {
    if (dirs.some(dir => exists(dir))) return browser
  }
  return undefined
}
