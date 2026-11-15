import {spawn, type ChildProcess} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {formatBytes} from './format.js'

const YOINKS_DIR = path.join(os.homedir(), '.yoinks', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
function commandWorks(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/**
 * Resolve a usable yt-dlp binary: system install first, then a previously
 * downloaded copy, then download the standalone binary from GitHub releases.
 */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  if (await commandWorks('yt-dlp', ['--version'])) return 'yt-dlp'

  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (await commandWorks(local, ['--version'])) return local

  onStatus('first run: fetching yt-dlp…')
  await fs.mkdir(YOINKS_DIR, {recursive: true})

  const url = `${RELEASE_BASE}/${ytDlpAssetName()}`
  const response = await fetch(url, {signal})
  if (!response.ok || !response.body) {
    throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
  }

  const tmp = `${local}.download`
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
  await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, local)
  return local
}

/**
 * Find ffmpeg for stream merging / mp3 extraction: system install first,
 * ffmpeg-static as fallback. Returns undefined if neither exists — yt-dlp
 * still works for single-file formats without it.
 */
export async function findFfmpeg(): Promise<string | undefined> {
  if (await commandWorks('ffmpeg', ['-version'])) return undefined // on PATH, yt-dlp finds it itself
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) return ffmpegPath
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  return undefined
}

export type VideoInfo = {
  _type?: 'video'
  title: string
  uploader?: string
  duration?: number
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
}

type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export type PlaylistEntry = {
  id?: string
  title?: string
  duration?: number
  /** Entry url, present in --flat-playlist output. */
  url?: string
}

export type PlaylistInfo = {
  _type: 'playlist'
  title?: string
  uploader?: string
  channel?: string
  playlist_count?: number
  entries?: PlaylistEntry[]
  webpage_url?: string
  extractor_key?: string
}

export type MediaInfo = VideoInfo | PlaylistInfo

export function isPlaylistInfo(info: MediaInfo): info is PlaylistInfo {
  return (info as PlaylistInfo)._type === 'playlist'
}

/** Entry count from whichever field the extractor filled in. */
export function playlistSize(info: PlaylistInfo): number {
  return info.playlist_count ?? info.entries?.length ?? 0
}

export type ProbeResult = {
  info: MediaInfo
  /**
   * Raw -J output saved to disk so downloads can skip re-extraction via
   * --load-info-json. Undefined for playlists: --flat-playlist entries carry
   * no formats, so there is nothing for yt-dlp to download from.
   */
  infoJsonPath?: string
}

/**
 * Probe a url, resolving it to a single video where it can be one.
 *
 * --flat-playlist keeps a playlist probe to a single cheap request (entries
 * come back as stubs rather than N full extractions) and is a no-op for a
 * plain video url, which still comes back with its full format list.
 */
export function probe(ytdlp: string, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  return runProbe(ytdlp, url, '--no-playlist', signal)
}

/**
 * Probe a url as a playlist. Needed because --no-playlist is the default:
 * a bare youtube "watch?v=…&list=RD…" mix url resolves to one video there,
 * but expands to hundreds of items here.
 */
export function probePlaylist(ytdlp: string, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  return runProbe(ytdlp, url, '--yes-playlist', signal)
}

async function runProbe(
  ytdlp: string,
  url: string,
  playlistFlag: '--no-playlist' | '--yes-playlist',
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ytdlp, ['-J', '--flat-playlist', playlistFlag, '--no-warnings', url], {signal})
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
      } else {
        resolve(out)
      }
    })
  })

  let info: MediaInfo
  try {
    info = JSON.parse(stdout) as MediaInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
  }

  if (isPlaylistInfo(info)) {
    if (playlistSize(info) === 0) throw new Error('That playlist looks empty.')
    return {info}
  }

  const infoJsonPath = path.join(os.tmpdir(), `yoinks-info-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, stdout)
  return {info, infoJsonPath}
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      label: `${height}p · mp4${sizeLabel}`,
      args: [
        '-f',
        `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      label: 'best available · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({
    kind: 'audio',
    label: `audio only · mp3${audioSizeLabel}`,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

const PLAYLIST_HEIGHTS = [1080, 720, 480]

/**
 * Format choices for a playlist. --flat-playlist entries carry no formats, so
 * unlike buildChoices these are resolution caps rather than a ladder of the
 * heights one video actually offers — which also means no size estimates, as
 * every item differs. Each selector falls back to best-available so a single
 * item without a matching rendition can't fail the whole run.
 */
export function buildPlaylistChoices(): DownloadChoice[] {
  const choices: DownloadChoice[] = [
    {kind: 'video', label: 'best available · mp4', args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4']},
  ]

  for (const height of PLAYLIST_HEIGHTS) {
    choices.push({
      kind: 'video',
      label: `up to ${height}p · mp4`,
      args: [
        '-f',
        `bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b`,
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  choices.push({
    kind: 'audio',
    label: 'audio only · mp3',
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
  /** 1-based playlist position, 0 for a single video. */
  item: number
  /** Playlist length, 0 for a single video. */
  totalItems: number
}

export type DownloadResult = {
  /** Every file written, in playlist order. A single video yields one. */
  filepaths: string[]
  /** Playlist items yt-dlp gave up on (unavailable, private, region-locked). */
  failed: number
}

/** "[download] Downloading item 3 of 12" → {item: 3, totalItems: 12} */
export function parsePlaylistItem(line: string): {item: number; totalItems: number} | undefined {
  const match = /^\[download\] Downloading item (\d+) of (\d+)/.exec(line)
  if (!match) return undefined
  return {item: Number(match[1]), totalItems: Number(match[2])}
}

/** "[download] C:\…\03 - clip.mp4 has already been downloaded" → the path */
export function parseAlreadyDownloaded(line: string): string | undefined {
  const match = /^\[download\] (.+) has already been downloaded$/.exec(line)
  return match?.[1]
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild?.kill('SIGTERM'))

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
    infoJsonPath?: string
    choice: DownloadChoice
    outDir: string
    /** Download every item behind the url instead of resolving it to one video. */
    playlist?: boolean
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const args = [
    // a playlist always re-extracts: the flat probe has no formats to reuse
    ...(opts.playlist || !opts.infoJsonPath ? [opts.url] : ['--load-info-json', opts.infoJsonPath]),
    ...opts.choice.args,
    ...(opts.playlist
      ? // one unavailable item shouldn't sink the other 40
        ['--yes-playlist', '--ignore-errors', '--no-abort-on-error']
      : ['--no-playlist']),
    '--no-warnings',
    '--newline',
    // --print implies --quiet, which suppresses progress bars and the
    // [Merger]/[ExtractAudio] lines we detect the processing phase from
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    opts.playlist
      ? // its own folder, numbered so the playlist's order survives on disk;
        // the title,id fallback chain keeps extractors that name neither from
        // producing a literal "NA" folder
        path.join(opts.outDir, '%(playlist_title,playlist_id|playlist).60s', '%(playlist_index)03d - %(title).60s.%(ext)s')
      : path.join(opts.outDir, '%(title).60s.%(ext)s'),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args, {signal})
    activeChild = child

    let stderr = ''
    const filepaths: string[] = []
    let part = 0
    let totalParts = 1
    let item = 0
    let totalItems = 0
    let lastDownloaded = 0
    let buffer = ''
    // every file yt-dlp writes this run, so a cancel can clean up after itself
    const destinations: string[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
          const downloadedBytes = toNumber(downloaded) ?? 0
          if (downloadedBytes < lastDownloaded) part++
          lastDownloaded = downloadedBytes
          handlers.onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
            item,
            totalItems,
          })
        } else if (parsePlaylistItem(line)) {
          // a new playlist item: the bar restarts, so reset the per-file counters
          const parsed = parsePlaylistItem(line)!
          item = parsed.item
          totalItems = parsed.totalItems
          part = 0
          totalParts = 1
          lastDownloaded = 0
        } else if (line.includes('Downloading 1 format(s):')) {
          // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
          const target = merging ?? extracting
          if (target) destinations.push(target)
          handlers.onProcessing()
        } else if (line.startsWith('[download] Destination: ')) {
          destinations.push(line.slice('[download] Destination: '.length))
        } else if (parseAlreadyDownloaded(line)) {
          // re-running a playlist skips finished items — count them as done,
          // otherwise they'd read as failures in the summary
          filepaths.push(parseAlreadyDownloaded(line)!)
        } else if (path.isAbsolute(line)) {
          filepaths.push(line)
        }
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      activeChild = undefined
      if (signal?.aborted) {
        // cancelled on purpose — don't leave half-written files behind
        void removePartials(destinations)
        reject(new Error('Download cancelled.'))
        return
      }
      const unique = [...new Set(filepaths)]
      const failed = totalItems > 0 ? Math.max(0, totalItems - unique.length) : 0
      if (code === 0 && unique.length > 0) {
        resolve({filepaths: unique, failed})
      } else if (opts.playlist && unique.length > 0) {
        // --ignore-errors exits non-zero when it skipped something; partial
        // success is still success for a playlist
        resolve({filepaths: unique, failed})
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

function removePartials(destinations: string[]): Promise<unknown> {
  return Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`])
      .map(file => fs.rm(file, {force: true})),
  )
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
