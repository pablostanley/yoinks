import assert from 'node:assert/strict'
import test from 'node:test'
import {parseArgs} from './args.js'
import {cookiesForUrl, detectCookieBrowser} from './browsers.js'
import {isThemeMode, nextThemeMode, themeFor} from '../theme.js'

test('parses a url and a spaced theme option without confusing the value for the url', () => {
  assert.deepEqual(parseArgs(['--theme', 'light', 'https://example.com/video']), {
    help: false,
    version: false,
    update: false,
    themeMode: 'light',
    initialUrl: 'https://example.com/video',
  })
})

test('parses an equals-style theme option after the url', () => {
  assert.deepEqual(parseArgs(['https://example.com/video', '--theme=dark']), {
    help: false,
    version: false,
    update: false,
    themeMode: 'dark',
    initialUrl: 'https://example.com/video',
  })
})

test('accepts a browser for --cookies in both spellings, plus none and auto', () => {
  assert.equal(parseArgs(['--cookies', 'firefox']).cookiesFrom, 'firefox')
  assert.equal(parseArgs(['--cookies=Chrome']).cookiesFrom, 'chrome')
  assert.equal(parseArgs(['--cookies', 'none']).cookiesFrom, 'none')
  assert.equal(parseArgs(['--cookies', 'auto']).cookiesFrom, 'auto')
  assert.equal(parseArgs(['https://example.com/video']).cookiesFrom, undefined)
})

test('picks an installed browser, prefers firefox, and gives up quietly on a bare machine', () => {
  const dirs = (browser: string) => (dir: string) => dir.toLowerCase().includes(browser)
  assert.equal(detectCookieBrowser(dirs('firefox')), 'firefox')
  assert.equal(detectCookieBrowser(dirs('chrome')), 'chrome')
  assert.equal(detectCookieBrowser(dirs('vivaldi')), 'vivaldi')
  // firefox wins when several are installed: chromium cookie stores are
  // encrypted on macOS and Windows
  assert.equal(detectCookieBrowser(dir => /firefox|chrome/i.test(dir)), 'firefox')
  assert.equal(detectCookieBrowser(() => false), undefined)
})

test('keeps guessed cookies away from youtube but honours a pinned browser', () => {
  const yt = 'https://youtu.be/Ywq6FMLbWH4'
  const ig = 'https://www.instagram.com/reel/abc123/'
  assert.equal(cookiesForUrl('firefox', true, yt), undefined)
  assert.equal(cookiesForUrl('firefox', true, 'https://music.youtube.com/watch?v=abc'), undefined)
  assert.equal(cookiesForUrl('firefox', true, ig), 'firefox')
  assert.equal(cookiesForUrl('firefox', false, yt), 'firefox')
  assert.equal(cookiesForUrl(undefined, true, ig), undefined)
})

test('rejects a browser yt-dlp cannot read cookies from', () => {
  assert.match(parseArgs(['--cookies']).error ?? '', /needs a browser/)
  assert.match(parseArgs(['--cookies', 'netscape']).error ?? '', /can’t read cookies/)
  assert.match(parseArgs(['--cookies=']).error ?? '', /can’t read cookies/)
})

test('takes --update as a standalone chore, with or without a url', () => {
  assert.equal(parseArgs(['--update']).update, true)
  assert.equal(parseArgs([]).update, false)
  assert.equal(parseArgs(['https://example.com/video']).update, false)
})

test('rejects missing, invalid, and unknown options', () => {
  assert.match(parseArgs(['--theme']).error ?? '', /needs a value/)
  assert.match(parseArgs(['--theme', 'sepia']).error ?? '', /unknown theme/)
  assert.match(parseArgs(['--wat']).error ?? '', /unknown option/)
  assert.match(parseArgs(['one', 'two']).error ?? '', /single url/)
})

test('recognizes only supported modes and cycles through all of them', () => {
  assert.equal(isThemeMode('auto'), true)
  assert.equal(isThemeMode('light'), true)
  assert.equal(isThemeMode('dark'), true)
  assert.equal(isThemeMode('sepia'), false)
  assert.equal(nextThemeMode('auto'), 'light')
  assert.equal(nextThemeMode('light'), 'dark')
  assert.equal(nextThemeMode('dark'), 'auto')
})

test('auto delegates to terminal colors while forced modes own the full surface', () => {
  assert.deepEqual(themeFor('auto'), {
    mode: 'auto',
    primary: undefined,
    gray: undefined,
    dark: undefined,
    background: undefined,
    dimSecondary: true,
    inverseButton: true,
  })

  assert.equal(themeFor('light').background, '#ffffff')
  assert.equal(themeFor('light').primary, '#18181b')
  assert.equal(themeFor('dark').background, '#18181b')
  assert.equal(themeFor('dark').primary, '#ffffff')
})
