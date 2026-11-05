import {spawn, spawnSync, type ChildProcess} from 'node:child_process'
import {createHash} from 'node:crypto'
import {rmSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {formatBytes} from './format.js'

const YOINKS_DIR = path.join(os.homedir(), '.yoinks', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

// yt-dlp is Python: force UTF-8 so non-latin titles survive on Windows
const YTDLP_ENV = {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'}

function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

// async so the UI keeps rendering while we check
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

/** Use an installed yt-dlp, else a cached copy, else download and verify one. */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  if (await commandWorks('yt-dlp', ['--version'])) return 'yt-dlp'

  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (await commandWorks(local, ['--version'])) return local

  onStatus('first run: fetching yt-dlp…')
  await fs.mkdir(YOINKS_DIR, {recursive: true})

  const asset = ytDlpAssetName()
  const tmp = `${local}.download`
  try {
    const [binary, sums] = await Promise.all([
      fetchOk(`${RELEASE_BASE}/${asset}`, signal).then(r => r.arrayBuffer()),
      fetchOk(`${RELEASE_BASE}/SHA2-256SUMS`, signal).then(r => r.text()),
    ])
    const data = Buffer.from(binary)
    const expected = expectedSha256(sums, asset)
    const actual = createHash('sha256').update(data).digest('hex')
    if (!expected || expected !== actual) {
      throw new Error('Downloaded yt-dlp failed its checksum. Try again later.')
    }
    await fs.writeFile(tmp, data, {mode: 0o755})
    await fs.rename(tmp, local)
  } finally {
    await fs.rm(tmp, {force: true})
  }
  return local
}

async function fetchOk(url: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, {signal})
  if (!response.ok) {
    throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
  }
  return response
}

export function expectedSha256(sums: string, asset: string): string | undefined {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/)
    if (name === asset && hash) return hash.toLowerCase()
  }
  return undefined
}

/** System ffmpeg, else the bundled ffmpeg-static. undefined means "let yt-dlp find it". */
export async function findFfmpeg(): Promise<string | undefined> {
  if (await commandWorks('ffmpeg', ['-version'])) return undefined
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) return ffmpegPath
  } catch {
    // not available on this platform
  }
  return undefined
}

// Running yt-dlp

let activeChild: ChildProcess | undefined

// last resort if we exit without a clean cancel
process.on('exit', () => {
  if (activeChild) killTreeSync(activeChild)
  for (const file of tempFiles) rmSync(file, {force: true})
})

function runYtDlp(cmd: string, args: string[], signal?: AbortSignal) {
  const child = spawn(cmd, ['--encoding', 'utf-8', ...args], {
    env: YTDLP_ENV,
    // own process group on unix so a cancel also stops ffmpeg
    detached: process.platform !== 'win32',
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  activeChild = child

  let killing: Promise<void> = Promise.resolve()
  const onAbort = () => (killing = killTree(child))
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, {once: true})

  child.on('close', () => {
    signal?.removeEventListener('abort', onAbort)
    if (activeChild === child) activeChild = undefined
  })
  return {child, killed: () => killing}
}

// yt-dlp.exe is a launcher plus a child, and ffmpeg runs below that: kill the whole tree
function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return Promise.resolve()
  if (process.platform !== 'win32') {
    killGroup(child)
    return Promise.resolve()
  }
  return new Promise(resolve => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore'})
    killer.on('error', () => {
      child.kill()
      resolve()
    })
    killer.on('close', () => resolve())
  })
}

function killTreeSync(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore'})
  else killGroup(child)
}

function killGroup(child: ChildProcess) {
  try {
    process.kill(-child.pid!, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

// Probe

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
  /** Saved probe output, so the download can skip re-extracting. */
  infoJsonPath: string
}

const tempFiles = new Set<string>()

export function removeInfoJson(file: string | undefined) {
  if (!file) return
  tempFiles.delete(file)
  void fs.rm(file, {force: true})
}

export async function probe(ytdlp: string, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const {child} = runYtDlp(ytdlp, ['-J', '--no-playlist', '--no-warnings', url], signal)
    let out = ''
    let stderr = ''
    child.stdout!.on('data', chunk => (out += chunk))
    child.stderr!.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (signal?.aborted) reject(new Error('Cancelled.'))
      else if (code !== 0) reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
      else resolve(out)
    })
  })

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
  }

  const infoJsonPath = path.join(os.tmpdir(), `yoinks-info-${process.pid}-${Date.now()}.json`)
  tempFiles.add(infoJsonPath)
  await fs.writeFile(infoJsonPath, stdout)
  return {info, infoJsonPath}
}

// Format choices

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

const mp4Video = (format: string) => ['-f', format, '--merge-output-format', 'mp4']
const mp3Audio = ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0']

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
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]!
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      label: `${height}p · mp4${sizeLabel}`,
      args: mp4Video(`bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`),
    })
  }

  if (choices.length === 0) {
    choices.push({kind: 'video', label: 'best available · mp4', args: mp4Video('bv*+ba/b')})
  }

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({kind: 'audio', label: `audio only · mp3${audioSizeLabel}`, args: mp3Audio})

  return choices
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

// Download

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** Number of files in this download (video + audio is 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    /** Reuse the probe output instead of re-extracting. */
    infoJsonPath?: string
    choice: DownloadChoice
    outDir: string
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<string> {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    // --print turns on --quiet, which would hide the progress and [Merger] lines we read
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
    const {child, killed} = runYtDlp(opts.ytdlp, args, signal)

    let stderr = ''
    let filepath = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''
    // files written this run, removed again on cancel
    const destinations: string[] = []

    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
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
          // "[info] xxx: Downloading 1 format(s): 395+251"
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
          const target = merging ?? extracting
          if (target) destinations.push(target)
          handlers.onProcessing()
        } else if (line.startsWith('[download] Destination: ')) {
          destinations.push(line.slice('[download] Destination: '.length))
        } else if (path.isAbsolute(line)) {
          filepath = line
        }
      }
    })
    child.stderr!.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (signal?.aborted) {
        void killed()
          .then(() => removePartials(destinations))
          .then(() => reject(new Error('Download cancelled.')))
        return
      }
      if (code === 0 && filepath) {
        resolve(filepath)
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

/** True when a failure looks like an expired media link, the only case worth a fresh retry. */
export function isExpiredLinkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP Error (403|404|410)|expired/i.test(message)
}

function removePartials(destinations: string[]): Promise<unknown> {
  return Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`])
      // Windows can hold the file a moment after the process dies
      .map(file => fs.rm(file, {force: true, maxRetries: 5, retryDelay: 200})),
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
