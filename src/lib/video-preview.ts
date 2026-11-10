import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {splitPngStream, type GraphicsMode} from './terminal-graphics.js'
import type {RawFormat, VideoInfo} from './ytdlp.js'

export type PreviewDimensions = {
  cols: number
  rows: number
}

export type PreviewFrame = string[]

export type ThumbnailGraphic = {
  lines?: PreviewFrame
  png?: Buffer
}

export type PreviewStream = {
  formatId: string
  url: string
  protocol?: string
  headers?: Record<string, string>
}

export type VideoClip = {
  startSec: number
  fps: number
  frames: PreviewFrame[]
  pngFrames?: Buffer[]
  stream?: PreviewStream
}

const ASCII_RAMP = ' .:-=+*#%@'
const DEFAULT_FETCH_TIMEOUT_MS = 8_000
const DEFAULT_STREAM_ATTEMPT_TIMEOUT_MS = 10_000
const MAX_BUFFER_BYTES = 32 * 1024 * 1024

function linkAbortSignal(parent?: AbortSignal, timeoutMs?: number): {signal: AbortSignal; cleanup: () => void} {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)

  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason)
      return {signal: controller.signal, cleanup: () => {}}
    }
    parent.addEventListener('abort', onAbort, {once: true})
  }

  const timer = timeoutMs
    ? setTimeout(() => controller.abort(new Error('Preview timed out')), timeoutMs)
    : undefined

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

function isHttpUrl(url: string | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

function isMediaSource(url: string | undefined): url is string {
  return typeof url === 'string' && (/^https?:\/\//i.test(url) || url.startsWith('file://') || path.isAbsolute(url))
}

function scoreThumbnail(t: {url: string; width?: number; preference?: number}): number {
  let score = 0
  if (typeof t.width === 'number' && t.width > 0) {
    if (t.width >= 320 && t.width <= 1280) {
      // Crisp enough for HD Kitty graphics while still fast to fetch
      score += 10_000 - Math.abs(t.width - 480)
    } else if (t.width > 1280) {
      score += 5_000 - Math.min(4_000, t.width - 1280)
    } else {
      score += 1_000 + t.width
    }
  } else {
    score += 3_000 + (t.preference ?? 0)
  }
  if (/\.(?:jpe?g|png)(?:$|\?)/i.test(t.url)) score += 50
  return score
}

/**
 * Return candidate thumbnail URLs ordered for fast, reliable terminal previewing.
 */
export function pickThumbnailUrls(info: VideoInfo): string[] {
  const ranked = (info.thumbnails ?? [])
    .filter((t): t is {url: string; width?: number; preference?: number; id?: string} => {
      if (!isHttpUrl(t.url)) return false
      if (t.id?.startsWith('sb')) return false
      if (/\.mhtml(?:$|\?)/i.test(t.url)) return false
      return true
    })
    .sort((a, b) => scoreThumbnail(b) - scoreThumbnail(a))
    .map(t => t.url)

  const seen = new Set<string>()
  const result: string[] = []
  for (const url of [...ranked, ...(isHttpUrl(info.thumbnail) ? [info.thumbnail] : [])]) {
    if (!seen.has(url)) {
      seen.add(url)
      result.push(url)
    }
  }
  return result
}

function isYoutubeInfo(info: VideoInfo): boolean {
  return (
    info.extractor_key?.toLowerCase() === 'youtube' ||
    Boolean(info.webpage_url && /(?:youtube\.com|youtu\.be)/i.test(info.webpage_url))
  )
}

function scorePreviewFormat(f: RawFormat, preferHls: boolean): number {
  let score = 0
  const isHls = f.protocol === 'm3u8' || f.protocol === 'm3u8_native'
  const isDirect = f.protocol === 'https' || f.protocol === 'http' || !f.protocol

  if (preferHls) {
    if (isHls) score += 100_000
    else if (isDirect) score += 60_000
    else score -= 50_000
  } else {
    if (isDirect) score += 100_000
    else if (isHls) score += 20_000
    else score -= 50_000
  }

  if (typeof f.height === 'number' && f.height > 0) {
    if (f.height >= 144 && f.height <= 360) score += 50_000 - Math.abs(f.height - 240) * 10
    else if (f.height < 144) score += 35_000 + f.height
    else if (f.height <= 480) score += 20_000 - f.height
    else score -= f.height
  } else {
    score += 10_000
  }

  if (f.vcodec?.startsWith('avc') || f.vcodec?.includes('h264')) score += 5_000
  else if (f.vcodec?.startsWith('vp9') || f.vcodec?.startsWith('vp09')) score += 3_000

  if (f.ext === 'mp4') score += 1_000
  return score
}

/**
 * Return ordered candidate video streams for fast random clip extraction.
 * On YouTube, HLS (`m3u8_native`) is prioritized ahead of direct `https`
 * streams because direct adaptive URLs frequently 403 or throttle range seeks.
 */
export function pickPreviewStreams(info: VideoInfo): PreviewStream[] {
  const preferHls = isYoutubeInfo(info)
  const candidates = (info.formats ?? [])
    .filter(
      f =>
        f.vcodec &&
        f.vcodec !== 'none' &&
        f.ext !== 'mhtml' &&
        f.protocol !== 'mhtml' &&
        isMediaSource(f.url),
    )
    .sort((a, b) => scorePreviewFormat(b, preferHls) - scorePreviewFormat(a, preferHls))

  const result: PreviewStream[] = []
  const seen = new Set<string>()
  for (const f of candidates) {
    if (seen.has(f.format_id)) continue
    seen.add(f.format_id)
    result.push({
      formatId: f.format_id,
      url: f.url!,
      protocol: f.protocol,
      headers: f.http_headers ?? info.http_headers,
    })
    if (result.length >= 4) break
  }

  if (result.length === 0 && isMediaSource(info.url)) {
    result.push({
      formatId: 'best',
      url: info.url,
      headers: info.http_headers,
    })
  }

  return result
}

export function pickPreviewStream(info: VideoInfo): PreviewStream | undefined {
  return pickPreviewStreams(info)[0]
}

export function hasVideoContent(info: VideoInfo): boolean {
  if (pickPreviewStream(info)) return true
  return (info.formats ?? []).some(
    f => Boolean(f.vcodec && f.vcodec !== 'none' && f.ext !== 'mhtml' && f.protocol !== 'mhtml'),
  )
}

/**
 * Pick a random clip start timestamp spread across the video, avoiding
 * intros/outros on longer videos and staying well-separated from recent clips.
 */
export function pickRandomClipTimestamp(
  duration: number | undefined,
  clipDurationSec: number,
  previousStarts: number[] = [],
): number {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return 0
  if (duration <= clipDurationSec + 0.5) return 0

  const minStart = duration > 15 ? duration * 0.05 : 0
  const maxRaw = duration - clipDurationSec
  const maxStart = Math.max(minStart, duration > 15 ? Math.min(maxRaw, duration * 0.93) : maxRaw)
  if (maxStart <= minStart) return Number(minStart.toFixed(2))

  const span = maxStart - minStart
  const recent = previousStarts.slice(-6)
  const targetGap = Math.min(span * 0.2, 8)

  let bestCandidate = minStart + Math.random() * span
  let bestDistance = -1

  for (let i = 0; i < 12; i++) {
    const candidate = minStart + Math.random() * span
    if (recent.length === 0) return Number(candidate.toFixed(2))
    let minDist = Infinity
    for (const prev of recent) {
      const dist = Math.abs(candidate - prev)
      if (dist < minDist) minDist = dist
    }
    if (minDist >= targetGap) return Number(candidate.toFixed(2))
    if (minDist > bestDistance) {
      bestDistance = minDist
      bestCandidate = candidate
    }
  }

  return Number(bestCandidate.toFixed(2))
}

/**
 * Convert an RGB24 pixel buffer (`pixelWidth * pixelHeight * 3` bytes, with
 * even `pixelHeight = rows * 2`) into half-block (`▀`) ANSI terminal rows.
 */
export function renderRgbFrameToLines(
  rgb: Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  options: {noColor?: boolean} = {},
): PreviewFrame {
  const rows = Math.floor(pixelHeight / 2)
  const noColor = options.noColor ?? Boolean(process.env.NO_COLOR)
  const lines: string[] = []

  for (let r = 0; r < rows; r++) {
    const yTop = r * 2
    const yBot = yTop + 1
    let line = ''

    if (noColor) {
      for (let x = 0; x < pixelWidth; x++) {
        const ti = (yTop * pixelWidth + x) * 3
        const bi = (yBot * pixelWidth + x) * 3
        const lumTop = 0.299 * rgb[ti]! + 0.587 * rgb[ti + 1]! + 0.114 * rgb[ti + 2]!
        const lumBot = 0.299 * rgb[bi]! + 0.587 * rgb[bi + 1]! + 0.114 * rgb[bi + 2]!
        const avg = (lumTop + lumBot) / 2
        const idx = Math.min(ASCII_RAMP.length - 1, Math.floor((avg / 255) * ASCII_RAMP.length))
        line += ASCII_RAMP[idx]!
      }
      lines.push(line)
      continue
    }

    let prevTr = -1
    let prevTg = -1
    let prevTb = -1
    let prevBr = -1
    let prevBg = -1
    let prevBb = -1

    for (let x = 0; x < pixelWidth; x++) {
      const ti = (yTop * pixelWidth + x) * 3
      const bi = (yBot * pixelWidth + x) * 3
      const tr = rgb[ti]!
      const tg = rgb[ti + 1]!
      const tb = rgb[ti + 2]!
      const br = rgb[bi]!
      const bg = rgb[bi + 1]!
      const bb = rgb[bi + 2]!

      if (tr !== prevTr || tg !== prevTg || tb !== prevTb || br !== prevBr || bg !== prevBg || bb !== prevBb) {
        line += `\x1b[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m`
        prevTr = tr
        prevTg = tg
        prevTb = tb
        prevBr = br
        prevBg = bg
        prevBb = bb
      }
      line += '▀'
    }
    line += '\x1b[0m'
    lines.push(line)
  }

  return lines
}

function targetPixelDimensions(dims: PreviewDimensions, mode: GraphicsMode): {pixelWidth: number; pixelHeight: number} {
  if (mode === 'kitty') {
    const rawW = Math.min(640, dims.cols * 12)
    const rawH = Math.min(360, dims.rows * 24)
    return {
      pixelWidth: rawW - (rawW % 2),
      pixelHeight: rawH - (rawH % 2),
    }
  }
  return {
    pixelWidth: dims.cols,
    pixelHeight: dims.rows * 2,
  }
}

function buildScaleFilter(pixelWidth: number, pixelHeight: number, fps?: number): string {
  const scale = `scale=${pixelWidth}:${pixelHeight}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${pixelWidth}:${pixelHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
  return fps ? `fps=${fps},${scale}` : scale
}

function runFfmpegBuffer(
  ffmpegPath: string,
  args: string[],
  stdinData?: Buffer,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'ignore'],
      signal,
    })

    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    child.stdout?.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes <= MAX_BUFFER_BYTES) {
        chunks.push(chunk)
      }
    })

    child.on('error', err => {
      if (settled) return
      settled = true
      reject(err)
    })

    child.on('close', code => {
      if (settled) return
      settled = true
      if (code === 0 && totalBytes <= MAX_BUFFER_BYTES) {
        resolve(Buffer.concat(chunks))
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`))
      }
    })

    if (stdinData && child.stdin) {
      child.stdin.on('error', () => {
        // ffmpeg may close early on invalid input; close handler settles promise
      })
      child.stdin.end(stdinData)
    }
  })
}

function splitHttpHeaders(headers: Record<string, string> | undefined): {
  userAgent?: string
  headersArg?: string
} {
  if (!headers) return {}
  let userAgent: string | undefined
  const lines: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'user-agent') {
      userAgent = value
    } else if (lower !== 'host' && lower !== 'content-length') {
      lines.push(`${key}: ${value}`)
    }
  }
  return {
    userAgent,
    headersArg: lines.length > 0 ? `${lines.join('\r\n')}\r\n` : undefined,
  }
}

/**
 * Fetch and decode the video's thumbnail as either a crisp Kitty PNG or
 * truecolor half-block lines.
 */
export async function fetchThumbnailGraphic(opts: {
  ffmpegPath: string
  info: VideoInfo
  dims: PreviewDimensions
  mode?: GraphicsMode
  noColor?: boolean
  signal?: AbortSignal
}): Promise<ThumbnailGraphic | undefined> {
  const mode = opts.mode ?? 'halfblock'
  const candidates = pickThumbnailUrls(opts.info).slice(0, 3)
  if (candidates.length === 0) return undefined

  const {pixelWidth, pixelHeight} = targetPixelDimensions(opts.dims, mode)
  const expectedRgbBytes = pixelWidth * pixelHeight * 3

  for (const url of candidates) {
    if (opts.signal?.aborted) return undefined
    const {signal, cleanup} = linkAbortSignal(opts.signal, DEFAULT_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, {headers: opts.info.http_headers, signal})
      if (!response.ok) continue
      const imageBytes = Buffer.from(await response.arrayBuffer())
      if (imageBytes.length === 0) continue

      const outputArgs =
        mode === 'kitty'
          ? ['-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']
          : ['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']

      const decoded = await runFfmpegBuffer(
        opts.ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          'pipe:0',
          '-vf',
          buildScaleFilter(pixelWidth, pixelHeight),
          ...outputArgs,
        ],
        imageBytes,
        signal,
      )

      if (mode === 'kitty') {
        const pngs = splitPngStream(decoded)
        if (pngs[0]) return {png: pngs[0]}
      } else if (decoded.length >= expectedRgbBytes) {
        return {lines: renderRgbFrameToLines(decoded, pixelWidth, pixelHeight, {noColor: opts.noColor})}
      }
    } catch {
      if (opts.signal?.aborted) return undefined
    } finally {
      cleanup()
    }
  }

  return undefined
}

export async function fetchThumbnailFrame(opts: {
  ffmpegPath: string
  info: VideoInfo
  dims: PreviewDimensions
  noColor?: boolean
  signal?: AbortSignal
}): Promise<PreviewFrame | undefined> {
  const graphic = await fetchThumbnailGraphic({...opts, mode: 'halfblock'})
  return graphic?.lines
}

function sliceRgbFrames(
  rgb: Buffer,
  pixelWidth: number,
  pixelHeight: number,
  noColor?: boolean,
): PreviewFrame[] {
  const frameBytes = pixelWidth * pixelHeight * 3
  if (frameBytes <= 0 || rgb.length < frameBytes) return []
  const count = Math.floor(rgb.length / frameBytes)
  const frames: PreviewFrame[] = []
  for (let i = 0; i < count; i++) {
    const slice = rgb.subarray(i * frameBytes, (i + 1) * frameBytes)
    frames.push(renderRgbFrameToLines(slice, pixelWidth, pixelHeight, {noColor}))
  }
  return frames
}

async function fetchSectionViaYtDlp(opts: {
  ytdlpPath: string
  ffmpegPath: string
  infoJsonPath: string
  formatId: string
  startSec: number
  clipDurationSec: number
  fps: number
  pixelWidth: number
  pixelHeight: number
  mode: GraphicsMode
  noColor?: boolean
  signal: AbortSignal
}): Promise<{frames: PreviewFrame[]; pngFrames?: Buffer[]}> {
  const tmpFile = path.join(os.tmpdir(), `yoinks-clip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`)
  const endSec = (opts.startSec + opts.clipDurationSec).toFixed(2)
  const args = [
    '--load-info-json',
    opts.infoJsonPath,
    '--no-warnings',
    '--no-playlist',
    '-f',
    opts.formatId,
    '--download-sections',
    `*${opts.startSec.toFixed(2)}-${endSec}`,
    '-o',
    tmpFile,
  ]
  if (opts.ffmpegPath !== 'ffmpeg') {
    args.push('--ffmpeg-location', opts.ffmpegPath)
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(opts.ytdlpPath, args, {stdio: 'ignore', signal: opts.signal})
      child.on('error', reject)
      child.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`yt-dlp exited with code ${code}`))
      })
    })
    const outputArgs =
      opts.mode === 'kitty'
        ? ['-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']
        : ['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']

    const decoded = await runFfmpegBuffer(
      opts.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        tmpFile,
        '-an',
        '-sn',
        '-dn',
        '-vf',
        buildScaleFilter(opts.pixelWidth, opts.pixelHeight, opts.fps),
        ...outputArgs,
      ],
      undefined,
      opts.signal,
    )
    if (opts.mode === 'kitty') {
      const pngFrames = splitPngStream(decoded)
      return {frames: [], pngFrames}
    }
    return {frames: sliceRgbFrames(decoded, opts.pixelWidth, opts.pixelHeight, opts.noColor)}
  } finally {
    await fs.rm(tmpFile, {force: true}).catch(() => {})
  }
}

/**
 * Extract a short video clip starting at `startSec`. Tries candidate streams in
 * order (with fast per-attempt timeouts) before falling back to `yt-dlp`
 * section downloading.
 */
export async function fetchVideoClip(opts: {
  ffmpegPath: string
  ytdlpPath?: string
  infoJsonPath?: string
  stream?: PreviewStream
  streams?: PreviewStream[]
  startSec: number
  clipDurationSec?: number
  fps?: number
  dims: PreviewDimensions
  mode?: GraphicsMode
  noColor?: boolean
  signal?: AbortSignal
}): Promise<VideoClip | undefined> {
  const mode = opts.mode ?? 'halfblock'
  const clipDurationSec = opts.clipDurationSec ?? 2.5
  const fps = opts.fps ?? 10
  const {pixelWidth, pixelHeight} = targetPixelDimensions(opts.dims, mode)
  const candidates = opts.streams ?? (opts.stream ? [opts.stream] : [])

  for (const stream of candidates) {
    if (opts.signal?.aborted) return undefined
    if (stream.protocol === 'http_dash_segments') continue

    const {signal, cleanup} = linkAbortSignal(opts.signal, DEFAULT_STREAM_ATTEMPT_TIMEOUT_MS)
    try {
      const {userAgent, headersArg} = splitHttpHeaders(stream.headers)
      const isHttp = /^https?:\/\//i.test(stream.url)
      const outputArgs =
        mode === 'kitty'
          ? ['-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']
          : ['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']

      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        ...(isHttp && userAgent ? ['-user_agent', userAgent] : []),
        ...(isHttp && headersArg ? ['-headers', headersArg] : []),
        ...(opts.startSec > 0 ? ['-ss', opts.startSec.toFixed(2)] : []),
        '-i',
        stream.url,
        '-t',
        clipDurationSec.toFixed(2),
        '-an',
        '-sn',
        '-dn',
        '-vf',
        buildScaleFilter(pixelWidth, pixelHeight, fps),
        ...outputArgs,
      ]

      const decoded = await runFfmpegBuffer(opts.ffmpegPath, args, undefined, signal)
      if (mode === 'kitty') {
        const pngFrames = splitPngStream(decoded)
        if (pngFrames.length > 0) {
          return {startSec: opts.startSec, fps, frames: [], pngFrames, stream}
        }
      } else {
        const frames = sliceRgbFrames(decoded, pixelWidth, pixelHeight, opts.noColor)
        if (frames.length > 0) {
          return {startSec: opts.startSec, fps, frames, stream}
        }
      }
    } catch {
      if (opts.signal?.aborted) return undefined
    } finally {
      cleanup()
    }
  }

  const fallbackFormat = candidates[0]?.formatId
  if (opts.ytdlpPath && opts.infoJsonPath && fallbackFormat && !opts.signal?.aborted) {
    const {signal, cleanup} = linkAbortSignal(opts.signal, DEFAULT_STREAM_ATTEMPT_TIMEOUT_MS + 4_000)
    try {
      const result = await fetchSectionViaYtDlp({
        ytdlpPath: opts.ytdlpPath,
        ffmpegPath: opts.ffmpegPath,
        infoJsonPath: opts.infoJsonPath,
        formatId: fallbackFormat,
        startSec: opts.startSec,
        clipDurationSec,
        fps,
        pixelWidth,
        pixelHeight,
        mode,
        noColor: opts.noColor,
        signal,
      })
      if (mode === 'kitty' && result.pngFrames && result.pngFrames.length > 0) {
        return {startSec: opts.startSec, fps, frames: [], pngFrames: result.pngFrames}
      }
      if (result.frames.length > 0) {
        return {startSec: opts.startSec, fps, frames: result.frames}
      }
    } catch {
      return undefined
    } finally {
      cleanup()
    }
  }

  return undefined
}
