import React from 'react'
import {createRequire} from 'node:module'
import {render} from 'ink'
import {App, type Outcome} from './app.js'
import {captureFrames} from './lib/click-map.js'
import {parseArgs} from './lib/args.js'
import {readClipboard} from './lib/clipboard.js'
import {isProbablyUrl} from './lib/platforms.js'
import {autoUpdateYtDlp, updateYtDlp} from './lib/ytdlp.js'

// read at runtime from the shipped package.json so npm version bumps
// can't drift from a hardcoded constant
const VERSION: string = createRequire(import.meta.url)('../package.json').version

const HELP = `
  yoinks — yoink any video. paste. yoink. done.

  Usage
    $ yoinks [url]

  Examples
    $ yoinks https://youtu.be/dQw4w9WgXcQ
    $ yoinks https://x.com/user/status/123456
    $ yoinks                 (prompts for a url)

  Options
    --theme <mode>  use auto, light, or dark for this run
    --update        update the bundled yt-dlp now, then exit
    -h, --help      show this help
    -v, --version   show version

  Downloads are saved to ~/Downloads.
  yt-dlp refreshes itself in the background about once a week.
  Powered by yt-dlp — YouTube, X, Instagram, Threads, TikTok & 1800+ sites.
`

const args = parseArgs(process.argv.slice(2))

if (args.error) {
  console.error(`yoinks: ${args.error}\nTry “yoinks --help” for usage.`)
  process.exit(1)
}

if (args.help) {
  console.log(HELP)
  process.exit(0)
}

if (args.version) {
  console.log(VERSION)
  process.exit(0)
}

// plain stdout on purpose — an update is a one-shot chore, not a session
if (args.update) {
  console.log('yoinks: checking yt-dlp…')
  const result = await updateYtDlp()
  if (result.status === 'updated') {
    console.log(`✓ yt-dlp updated${result.from ? `: ${result.from} → ${result.to}` : ` to ${result.to}`}`)
  } else if (result.status === 'current') {
    console.log(`✓ yt-dlp is already current (${result.version})`)
  } else if (result.status === 'system') {
    console.log(
      `yoinks uses the yt-dlp already on your PATH${result.version ? ` (${result.version})` : ''} — ` +
        'update it the way you installed it.',
    )
  } else {
    console.error(`yoinks: could not check for updates — ${result.reason}`)
    process.exit(1)
  }
  process.exit(0)
}

const initialUrl = args.initialUrl
const initialThemeMode = args.themeMode ?? 'auto'

const isTTY = Boolean(process.stdout.isTTY)

// no url given — offer the clipboard url (⇥ to paste) when it already holds one
let clipboardUrl: string | undefined
if (!initialUrl && isTTY) {
  const clipped = readClipboard().trim()
  // reject multi-line clipboard content — new URL() silently strips newlines
  if (clipped && !/\s/.test(clipped) && isProbablyUrl(clipped)) clipboardUrl = clipped
}
const enterAltScreen = () => process.stdout.write('\x1b[?1049h\x1b[H')
// also switch mouse tracking off — a crash can skip React effect cleanup
const leaveAltScreen = () => process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')

if (isTTY) {
  enterAltScreen()
  process.on('exit', leaveAltScreen)
  // restore the terminal BEFORE a crash prints, or the stack trace is
  // wiped along with the alternate screen and the app looks like it
  // silently quit
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (error: unknown) => {
      leaveAltScreen()
      console.error(error)
      process.exit(1)
    })
  }
}

// a stale yt-dlp is the usual reason downloads start failing; keep it fresh
// quietly while the user works
const stopAutoUpdate = autoUpdateYtDlp()

let outcome: Outcome = {}
const {waitUntilExit} = render(
  <App
    initialUrl={initialUrl}
    clipboardUrl={clipboardUrl}
    initialThemeMode={initialThemeMode}
    onOutcome={result => (outcome = result)}
  />,
  // keep a copy of every frame so clicks can be hit-tested against it
  {stdout: captureFrames(process.stdout)},
)

await waitUntilExit()

// quitting must quit: an in-flight background update would otherwise hold
// the process open on a restored terminal, looking like a hang
stopAutoUpdate()

if (isTTY) leaveAltScreen()
if (outcome.filepath) {
  console.log(`✓ yoinked → ${outcome.filepath}`)
}
