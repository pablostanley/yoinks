import {isThemeMode, type ThemeMode} from '../theme.js'
import {COOKIE_BROWSERS, isCookieBrowser, type CookieBrowser} from './config.js'

export type CliArgs = {
  help: boolean
  version: boolean
  update: boolean
  initialUrl?: string
  themeMode?: ThemeMode
  /**
   * A browser name pins it, 'none' stays signed out, 'auto' goes back to
   * picking an installed browser by itself.
   */
  cookiesFrom?: CookieBrowser | 'none' | 'auto'
  error?: string
}

const COOKIE_VALUES = `${COOKIE_BROWSERS.join(', ')}, auto, or none`

function readCookiesValue(value: string | undefined): CookieBrowser | 'none' | 'auto' | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase()
  if (normalized === 'none' || normalized === 'off') return 'none'
  if (normalized === 'auto') return 'auto'
  return isCookieBrowser(normalized) ? normalized : undefined
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {help: false, version: false, update: false}
  const positional: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '-h' || arg === '--help') {
      result.help = true
    } else if (arg === '-v' || arg === '--version') {
      result.version = true
    } else if (arg === '--update') {
      result.update = true
    } else if (arg === '--cookies') {
      const value = args[++index]
      if (!value) return {...result, error: `--cookies needs a browser: ${COOKIE_VALUES}`}
      const parsed = readCookiesValue(value)
      if (!parsed) return {...result, error: `can’t read cookies from “${value}” — use ${COOKIE_VALUES}`}
      result.cookiesFrom = parsed
    } else if (arg.startsWith('--cookies=')) {
      const value = arg.slice('--cookies='.length)
      const parsed = readCookiesValue(value)
      if (!parsed) return {...result, error: `can’t read cookies from “${value}” — use ${COOKIE_VALUES}`}
      result.cookiesFrom = parsed
    } else if (arg === '--theme') {
      const value = args[++index]
      if (!value) return {...result, error: '--theme needs a value: auto, light, or dark'}
      if (!isThemeMode(value)) return {...result, error: `unknown theme “${value}” — use auto, light, or dark`}
      result.themeMode = value
    } else if (arg.startsWith('--theme=')) {
      const value = arg.slice('--theme='.length)
      if (!isThemeMode(value)) return {...result, error: `unknown theme “${value}” — use auto, light, or dark`}
      result.themeMode = value
    } else if (arg.startsWith('-')) {
      return {...result, error: `unknown option “${arg}”`}
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) return {...result, error: 'expected a single url'}
  result.initialUrl = positional[0]
  return result
}
