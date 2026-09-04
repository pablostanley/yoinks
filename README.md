# yoinks

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="yoinks" width="288">
</picture>

yoink any video. paste. yoink. done.

Download videos from YouTube, X/Twitter, Instagram, Threads, TikTok and
1,800+ other sites — right from your terminal. Paste a url, pick a
resolution (or audio-only mp3), done. No popups, no fake download buttons,
no sketchy redirects.

<img src="assets/home.png" alt="yoinks home screen — paste a link and hit yoink" width="100%">

## Install

```sh
npm install -g yoinks
```

Or try it without installing anything:

```sh
npx yoinks
```

Requires Node 18+. Everything else (yt-dlp, ffmpeg) is fetched or bundled
automatically.

## Usage

```sh
$ yoinks https://youtu.be/dQw4w9WgXcQ    # straight to the format picker
$ yoinks                                 # prompts for a url
$ yoinks --theme light                   # force the light palette
$ yoinks --update                        # refresh the bundled yt-dlp now
$ yoinks --cookies none                  # download signed out
```

Some links need you to be logged in: private accounts, stories, anything
age-gated, and — more and more often — ordinary Instagram posts. So yoinks
signs in as you by default: it finds an installed browser (Firefox first,
since Chromium browsers encrypt their cookie store on macOS and Windows)
and lets yt-dlp borrow its cookies. The footer names the browser in use.
If borrowed cookies turn out to be unusable — locked profile, encrypted
store, a site that rejects them — it quietly carries on signed out rather
than failing the download.

YouTube is the one exception: automatic sign-in skips it. YouTube rotates
the cookies of a signed-in session constantly, so a running browser's jar
is usually stale by the time yt-dlp reads it, and the player answers
“The page needs to be reloaded” for a video that downloads fine signed
out. Pinning a browser with `--cookies firefox` still covers YouTube —
that one is a deliberate choice, and age-gated videos need it.

Use `--cookies firefox` (or `chrome`, `brave`, `edge`, `safari`, …) to pin
a specific browser, `--cookies none` to stay signed out, and
`--cookies auto` to go back to picking automatically. Whatever you choose
is remembered in `~/.config/yoinks/config.json`.

yoinks takes over the terminal (full-screen, centered — and restores your
scrollback on exit). Pick a format with ↑/↓ (or j/k, or number keys) and
hit enter. `esc` goes back, `^c` quits. Or just use the mouse — the yoink
button, the format list and the footer hints are all clickable, and
clicking the logo takes you back home. Files are saved to `~/Downloads`,
and the file path is printed to your terminal when you're done. On the
finished screen, `o` opens the download in your file manager (Finder and
Explorer highlight the file itself).

The default `auto` theme uses your terminal's own foreground and background,
so it follows light and dark terminal themes without guessing. Press `^t` or
click the theme control in the footer to cycle through `auto`, `light`, and
`dark` for the current session. Use `--theme auto`, `--theme light`, or
`--theme dark` to choose the starting theme for one launch.

<img src="assets/download-options.png" alt="yoinks format picker — resolutions with estimated file sizes, plus audio-only mp3" width="100%">

## How it works

- Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). On first run,
  yoinks downloads the standalone yt-dlp binary to `~/.yoinks/bin` —
  no Python required. If you already have yt-dlp installed, it uses yours.
- That downloaded copy refreshes itself in the background roughly once a
  week, because sites break old yt-dlp builds faster than anyone updates
  them by hand. `yoinks --update` does it on demand. A yt-dlp you installed
  yourself is never overwritten — update it however you installed it.
- Fragmented streams (YouTube, HLS) are fetched four fragments at a time,
  which gets around per-connection throttling.
- ffmpeg (needed for merging high-res streams and mp3 extraction) is found
  on your PATH, with `ffmpeg-static` as a bundled fallback.
- The UI is [Ink](https://github.com/vadimdemedes/ink) — React for the
  terminal.

## Development

```sh
npm install
npm run build        # bundle to dist/ with tsup
npm run dev          # rebuild on change
node dist/cli.js <url>
npm run typecheck
```

To try it as a global command without publishing: `npm link`, then run
`yoinks` anywhere.

## Roadmap

- [ ] `--best` / `--mp3` flags to skip the picker (scriptable mode)
- [ ] `-o <dir>` to choose the output folder
- [ ] Playlist / thread-with-multiple-videos support
- [ ] Clipboard detection: launch bare and auto-suggest the url you copied
- [x] Self-update for the bundled yt-dlp binary
- [x] Publish to npm (`npm i -g yoinks` / `npx yoinks`)
- [ ] `curl yoinks.sh | sh` installer

## A note on fair use

yoinks is a personal-archiving tool. Downloading content may violate a
platform's terms of service — only download what you have the right to
keep, and be excellent to creators.

## License

[MIT](LICENSE)
