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
function commandWorks(cmd: string, args: string[], signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout: 10_000, signal})
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
  if (await commandWorks('yt-dlp', ['--version'], signal)) return 'yt-dlp'

  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (await commandWorks(local, ['--version'], signal)) return local

  // a cancelled check also returns false
  signal?.throwIfAborted()
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

export type ProbeResult = {
  info: VideoInfo
  /** Raw -J output saved to disk so downloads can skip re-extraction via --load-info-json. */
  infoJsonPath: string
}

export async function probe(ytdlp: string, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ytdlp, ['-J', '--no-playlist', '--no-warnings', url], {signal})
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

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
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

// QuickTime can't play VP9 and only newer Macs play AV1, but yt-dlp picks
// them over H.264. Ask for H.264 first, then AV1, with AAC audio.
const WITH_AAC = '+(ba[acodec^=mp4a]/ba)'

function videoSelector(height: number): string {
  return [
    `bv*[height=${height}][vcodec~='^(avc|h264)']${WITH_AAC}`,
    `bv*[height=${height}][vcodec^=av01]${WITH_AAC}`,
    `bv*[height=${height}]+ba`,
    `b[height=${height}]`,
    `bv*[height<=${height}]+ba`,
    'b',
  ].join('/')
}

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort(byBitrate)[0]
  const audioSize = sizeOf(bestAudio)
  const videoAudio = audioOnly.filter(f => f.acodec?.startsWith('mp4a')).sort(byBitrate)[0] ?? bestAudio

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    // guess the stream videoSelector will get, so the size matches the download
    const preferred = [isH264, isAv1].map(is => candidates.filter(is)).find(group => group.length > 0) ?? candidates
    const best = [...preferred].sort((a, b) => Number(Boolean(sizeOf(b))) - Number(Boolean(sizeOf(a))) || byBitrate(a, b))[0]!
    const muxed = best.acodec && best.acodec !== 'none'
    const audio = isH264(best) || isAv1(best) ? videoAudio : bestAudio
    const videoSize = sizeOf(best) ?? (best.tbr && info.duration ? (best.tbr * 1000 * info.duration) / 8 : undefined)
    // if the video size is unknown, show nothing rather than just the audio size
    const size = videoSize === undefined ? 0 : videoSize + (muxed ? 0 : sizeOf(audio) ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      label: `${height}p · mp4${sizeLabel}`,
      args: ['-f', videoSelector(height), '--merge-output-format', 'mp4'],
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

const isH264 = (f: RawFormat) => /^(avc|h264)/.test(f.vcodec ?? '')
const isAv1 = (f: RawFormat) => f.vcodec?.startsWith('av01') ?? false
const sizeOf = (f?: RawFormat) => f?.filesize ?? f?.filesize_approx
const byBitrate = (a: RawFormat, b: RawFormat) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0)

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild?.kill('SIGTERM'))

type DownloadOptions = {
  ytdlp: string
  ffmpegLocation?: string
  url: string
  /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
  infoJsonPath?: string
  choice: DownloadChoice
  outDir: string
}

export async function download(opts: DownloadOptions, handlers: DownloadHandlers, signal?: AbortSignal): Promise<string> {
  // yt-dlp skips a file that already exists and returns the old one, so
  // download into an empty folder and pick a free name at the end
  await fs.mkdir(opts.outDir, {recursive: true})
  const staging = await fs.mkdtemp(path.join(opts.outDir, '.yoinks-'))
  try {
    const staged = await runYtDlp({...opts, outDir: staging}, handlers, signal)
    return await moveToFreeName(staged, opts.outDir)
  } finally {
    // this also removes partial files from a cancelled or failed download
    await fs.rm(staging, {recursive: true, force: true}).catch(() => {})
  }
}

/** Moves file into dir, adding " (1)", " (2)"… if the name is taken. */
async function moveToFreeName(file: string, dir: string): Promise<string> {
  const {name, ext} = path.parse(file)
  for (let n = 0; ; n++) {
    const target = path.join(dir, n === 0 ? `${name}${ext}` : `${name} (${n})${ext}`)
    const taken = await fs.lstat(target).then(
      () => true,
      () => false,
    )
    if (!taken) {
      await fs.rename(file, target)
      return target
    }
  }
}

function runYtDlp(opts: DownloadOptions, handlers: DownloadHandlers, signal?: AbortSignal): Promise<string> {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    '--no-playlist',
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
    path.join(opts.outDir, '%(title).60s.%(ext)s'),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args, {signal})
    activeChild = child

    let stderr = ''
    let filepath = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''

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
          })
        } else if (line.includes('Downloading 1 format(s):')) {
          // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          handlers.onProcessing()
        } else if (path.isAbsolute(line)) {
          filepath = line
        }
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', error => {
      if (!signal?.aborted) reject(error)
    })
    // on cancel, wait for yt-dlp to exit but not for 'close': something it
    // started (like ffmpeg) can keep the pipes open for a while
    child.on('exit', () => {
      activeChild = undefined
      if (signal?.aborted) reject(new Error('Download cancelled.'))
    })
    child.on('close', code => {
      if (signal?.aborted) return
      if (code === 0 && filepath) {
        resolve(filepath)
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
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
