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
const DEFAULT_STREAM_ATTEMPT_TIMEOUT_MS = 5_000
const DEFAULT_SECTION_TIMEOUT_MS = 14_000
const DEFAULT_LOCAL_FALLBACK_TIMEOUT_MS = 30_000
const MAX_BUFFER_BYTES = 32 * 1024 * 1024

const AUDIO_ONLY_EXTS = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'wav', 'flac', 'weba'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'flv', 'ts', 'avi'])
const FORBIDDEN_FETCH_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding'])
const COOKIE_ATTRS = new Set(['domain', 'path', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'priority'])

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

function sanitizeFetchHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!FORBIDDEN_FETCH_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Convert yt-dlp's `Set-Cookie` style `cookies` string into a plain HTTP
 * `Cookie` header (`name=value; ...`), stripping Domain/Path/Expires attributes.
 */
export function parseCookieHeader(rawCookies: string | undefined): string | undefined {
  if (!rawCookies) return undefined
  const pairs: string[] = []
  for (const part of rawCookies.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (!name || COOKIE_ATTRS.has(name.toLowerCase())) continue
    pairs.push(`${name}=${part.slice(eq + 1).trim()}`)
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

function scoreThumbnail(t: {url: string; width?: number; preference?: number}): number {
  let score = 0
  if (typeof t.width === 'number' && t.width > 0) {
    if (t.width >= 320 && t.width <= 1280) {
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

type ThumbnailCandidate = {
  url: string
  headers?: Record<string, string>
}

function pickThumbnailCandidates(info: VideoInfo): ThumbnailCandidate[] {
  const ranked = (info.thumbnails ?? [])
    .filter((t): t is {url: string; width?: number; preference?: number; id?: string; http_headers?: Record<string, string>} => {
      if (!isHttpUrl(t.url)) return false
      if (t.id?.startsWith('sb')) return false
      if (/\.mhtml(?:$|\?)/i.test(t.url)) return false
      return true
    })
    .sort((a, b) => scoreThumbnail(b) - scoreThumbnail(a))
    .map(t => ({url: t.url, headers: mergeCookieHeader(t.http_headers ?? info.http_headers, info.cookies)}))

  const seen = new Set<string>()
  const result: ThumbnailCandidate[] = []
  const fallbackHeaders = mergeCookieHeader(info.http_headers, info.cookies)
  const all = [
    ...ranked,
    ...(isHttpUrl(info.thumbnail) ? [{url: info.thumbnail, headers: fallbackHeaders}] : []),
  ]
  for (const item of all) {
    if (!seen.has(item.url)) {
      seen.add(item.url)
      result.push(item)
    }
  }
  return result
}

/**
 * Return candidate thumbnail URLs ordered for fast, reliable terminal previewing.
 */
export function pickThumbnailUrls(info: VideoInfo): string[] {
  return pickThumbnailCandidates(info).map(c => c.url)
}

function isYoutubeInfo(info: VideoInfo): boolean {
  return (
    info.extractor_key?.toLowerCase() === 'youtube' ||
    Boolean(info.webpage_url && /(?:youtube\.com|youtu\.be)/i.test(info.webpage_url))
  )
}

/**
 * Treat formats as video unless they are explicitly storyboards or audio-only.
 * Many non-YouTube extractors (Instagram, TikTok, X, Reddit, generic) leave
 * `vcodec` unset on MP4/HLS streams.
 */
export function isVideoFormat(f: RawFormat): boolean {
  if (f.ext === 'mhtml' || f.protocol === 'mhtml') return false
  if (f.vcodec === 'none') return false
  if (f.vcodec && f.vcodec !== 'none') return true
  if ((f.height && f.height > 0) || (f.width && f.width > 0)) return true
  const ext = f.ext?.toLowerCase() ?? ''
  if (AUDIO_ONLY_EXTS.has(ext)) return false
  if (VIDEO_EXTS.has(ext)) return true
  return !f.acodec || f.acodec === 'none'
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

function streamHostKey(url: string, protocol?: string): string {
  try {
    return `${protocol ?? 'http'}:${new URL(url).hostname}`
  } catch {
    return `${protocol ?? 'local'}:${url}`
  }
}

/**
 * Return ordered candidate video streams for fast random clip extraction,
 * deduplicated by protocol + hostname so blocked CDNs don't waste repeated timeouts.
 */
export function pickPreviewStreams(info: VideoInfo): PreviewStream[] {
  const preferHls = isYoutubeInfo(info)
  const candidates = (info.formats ?? [])
    .filter(f => isVideoFormat(f) && isMediaSource(f.url))
    .sort((a, b) => scorePreviewFormat(b, preferHls) - scorePreviewFormat(a, preferHls))

  const result: PreviewStream[] = []
  const seenHosts = new Set<string>()
  for (const f of candidates) {
    const key = streamHostKey(f.url!, f.protocol)
    if (seenHosts.has(key)) continue
    seenHosts.add(key)
    const headers = mergeCookieHeader(f.http_headers ?? info.http_headers, f.cookies ?? info.cookies)
    result.push({
      formatId: f.format_id,
      url: f.url!,
      protocol: f.protocol,
      headers,
    })
    if (result.length >= 3) break
  }

  if (result.length === 0 && isMediaSource(info.url)) {
    result.push({
      formatId: 'best',
      url: info.url,
      headers: mergeCookieHeader(info.http_headers, info.cookies),
    })
  }

  return result
}

export function pickPreviewStream(info: VideoInfo): PreviewStream | undefined {
  return pickPreviewStreams(info)[0]
}

export function hasVideoContent(info: VideoInfo): boolean {
  if (pickPreviewStream(info)) return true
  const formats = info.formats ?? []
  if (formats.length === 0) return Boolean(info.webpage_url || info.url)
  return formats.some(isVideoFormat)
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

function mergeCookieHeader(
  headers: Record<string, string> | undefined,
  rawCookies: string | undefined,
): Record<string, string> | undefined {
  const parsed = parseCookieHeader(rawCookies)
  if (!parsed) return headers
  const hasCookie = headers && Object.keys(headers).some(k => k.toLowerCase() === 'cookie')
  if (hasCookie) return headers
  return {...headers, Cookie: parsed}
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

async function decodeImageBuffer(opts: {
  ffmpegPath: string
  imageBytes: Buffer
  pixelWidth: number
  pixelHeight: number
  mode: GraphicsMode
  noColor?: boolean
  signal: AbortSignal
}): Promise<ThumbnailGraphic | undefined> {
  const outputArgs =
    opts.mode === 'kitty'
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
      buildScaleFilter(opts.pixelWidth, opts.pixelHeight),
      ...outputArgs,
    ],
    opts.imageBytes,
    opts.signal,
  )

  if (opts.mode === 'kitty') {
    const pngs = splitPngStream(decoded)
    return pngs[0] ? {png: pngs[0]} : undefined
  }
  const expectedRgbBytes = opts.pixelWidth * opts.pixelHeight * 3
  if (decoded.length >= expectedRgbBytes) {
    return {lines: renderRgbFrameToLines(decoded, opts.pixelWidth, opts.pixelHeight, {noColor: opts.noColor})}
  }
  return undefined
}

async function runYtDlpCommand(ytdlpPath: string, args: string[], signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ytdlpPath, args, {stdio: 'ignore', signal})
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`yt-dlp exited with code ${code}`))))
  })
}

async function fetchThumbnailViaYtDlp(opts: {
  ytdlpPath: string
  ffmpegPath: string
  infoJsonPath?: string
  videoUrl?: string
  pixelWidth: number
  pixelHeight: number
  mode: GraphicsMode
  noColor?: boolean
  signal?: AbortSignal
}): Promise<ThumbnailGraphic | undefined> {
  const sourceArgs = opts.infoJsonPath
    ? [['--load-info-json', opts.infoJsonPath], ...(opts.videoUrl ? [[opts.videoUrl]] : [])]
    : opts.videoUrl
      ? [[opts.videoUrl]]
      : []

  for (const src of sourceArgs) {
    if (opts.signal?.aborted) return undefined
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-thumb-'))
    const {signal, cleanup} = linkAbortSignal(opts.signal, DEFAULT_FETCH_TIMEOUT_MS + 4_000)
    try {
      await runYtDlpCommand(
        opts.ytdlpPath,
        [...src, '--no-warnings', '--no-playlist', '--write-thumbnail', '--skip-download', '-o', path.join(tmpDir, 'thumb.%(ext)s')],
        signal,
      )
      const files = (await fs.readdir(tmpDir)).filter(name => !name.endsWith('.part'))
      for (const file of files) {
        const imageBytes = await fs.readFile(path.join(tmpDir, file))
        if (imageBytes.length === 0) continue
        const graphic = await decodeImageBuffer({
          ffmpegPath: opts.ffmpegPath,
          imageBytes,
          pixelWidth: opts.pixelWidth,
          pixelHeight: opts.pixelHeight,
          mode: opts.mode,
          noColor: opts.noColor,
          signal,
        }).catch(() => undefined)
        if (graphic) return graphic
      }
    } catch {
      // try next source
    } finally {
      cleanup()
      await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => {})
    }
  }
  return undefined
}

/**
 * Fetch and decode the video's thumbnail as either a crisp Kitty PNG or
 * truecolor half-block lines, falling back to `yt-dlp --write-thumbnail` if
 * direct HTTP requests are blocked by a CDN.
 */
export async function fetchThumbnailGraphic(opts: {
  ffmpegPath: string
  info: VideoInfo
  dims: PreviewDimensions
  mode?: GraphicsMode
  ytdlpPath?: string
  infoJsonPath?: string
  videoUrl?: string
  noColor?: boolean
  signal?: AbortSignal
}): Promise<ThumbnailGraphic | undefined> {
  const mode = opts.mode ?? 'halfblock'
  const candidates = pickThumbnailCandidates(opts.info).slice(0, 4)
  const {pixelWidth, pixelHeight} = targetPixelDimensions(opts.dims, mode)

  for (const candidate of candidates) {
    if (opts.signal?.aborted) return undefined
    const {signal, cleanup} = linkAbortSignal(opts.signal, DEFAULT_FETCH_TIMEOUT_MS)
    try {
      const headers = sanitizeFetchHeaders(candidate.headers)
      const response = await fetch(candidate.url, {headers, signal})
      if (!response.ok) continue
      const imageBytes = Buffer.from(await response.arrayBuffer())
      if (imageBytes.length === 0) continue

      const graphic = await decodeImageBuffer({
        ffmpegPath: opts.ffmpegPath,
        imageBytes,
        pixelWidth,
        pixelHeight,
        mode,
        noColor: opts.noColor,
        signal,
      })
      if (graphic) return graphic
    } catch {
      if (opts.signal?.aborted) return undefined
    } finally {
      cleanup()
    }
  }

  if (opts.ytdlpPath && (opts.infoJsonPath || opts.videoUrl) && !opts.signal?.aborted) {
    return fetchThumbnailViaYtDlp({
      ytdlpPath: opts.ytdlpPath,
      ffmpegPath: opts.ffmpegPath,
      infoJsonPath: opts.infoJsonPath,
      videoUrl: opts.videoUrl ?? opts.info.webpage_url,
      pixelWidth,
      pixelHeight,
      mode,
      noColor: opts.noColor,
      signal: opts.signal,
    })
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

async function decodeVideoInput(opts: {
  ffmpegPath: string
  input: string
  startSec?: number
  clipDurationSec: number
  fps: number
  pixelWidth: number
  pixelHeight: number
  mode: GraphicsMode
  headers?: Record<string, string>
  noColor?: boolean
  signal: AbortSignal
}): Promise<{frames: PreviewFrame[]; pngFrames?: Buffer[]}> {
  const isHttp = /^https?:\/\//i.test(opts.input)
  const {userAgent, headersArg} = isHttp ? splitHttpHeaders(opts.headers) : {}
  const outputArgs =
    opts.mode === 'kitty'
      ? ['-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']
      : ['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(isHttp && userAgent ? ['-user_agent', userAgent] : []),
    ...(isHttp && headersArg ? ['-headers', headersArg] : []),
    ...(opts.startSec && opts.startSec > 0 ? ['-ss', opts.startSec.toFixed(2)] : []),
    '-i',
    opts.input,
    '-t',
    opts.clipDurationSec.toFixed(2),
    '-an',
    '-sn',
    '-dn',
    '-vf',
    buildScaleFilter(opts.pixelWidth, opts.pixelHeight, opts.fps),
    ...outputArgs,
  ]

  const decoded = await runFfmpegBuffer(opts.ffmpegPath, args, undefined, opts.signal)
  if (opts.mode === 'kitty') {
    return {frames: [], pngFrames: splitPngStream(decoded)}
  }
  return {frames: sliceRgbFrames(decoded, opts.pixelWidth, opts.pixelHeight, opts.noColor)}
}

async function fetchSectionViaYtDlp(opts: {
  ytdlpPath: string
  ffmpegPath: string
  infoJsonPath?: string
  videoUrl?: string
  startSec: number
  clipDurationSec: number
  fps: number
  pixelWidth: number
  pixelHeight: number
  mode: GraphicsMode
  noColor?: boolean
  signal: AbortSignal
}): Promise<{frames: PreviewFrame[]; pngFrames?: Buffer[]}> {
  const sourceArgs = opts.infoJsonPath
    ? [['--load-info-json', opts.infoJsonPath], ...(opts.videoUrl ? [[opts.videoUrl]] : [])]
    : opts.videoUrl
      ? [[opts.videoUrl]]
      : []

  const endSec = (opts.startSec + opts.clipDurationSec).toFixed(2)
  for (const src of sourceArgs) {
    if (opts.signal.aborted) break
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-clip-'))
    try {
      const args = [
        ...src,
        '--no-warnings',
        '--no-playlist',
        '-f',
        'bv*[height<=480]/bv*/b',
        '--download-sections',
        `*${opts.startSec.toFixed(2)}-${endSec}`,
        '-o',
        path.join(tmpDir, 'clip.%(ext)s'),
      ]
      if (opts.ffmpegPath !== 'ffmpeg') args.push('--ffmpeg-location', opts.ffmpegPath)

      await runYtDlpCommand(opts.ytdlpPath, args, opts.signal)
      const files = (await fs.readdir(tmpDir)).filter(name => !name.endsWith('.part') && !name.endsWith('.ytdl'))
      for (const file of files) {
        const result = await decodeVideoInput({
          ffmpegPath: opts.ffmpegPath,
          input: path.join(tmpDir, file),
          clipDurationSec: opts.clipDurationSec,
          fps: opts.fps,
          pixelWidth: opts.pixelWidth,
          pixelHeight: opts.pixelHeight,
          mode: opts.mode,
          noColor: opts.noColor,
          signal: opts.signal,
        })
        if ((opts.mode === 'kitty' && result.pngFrames && result.pngFrames.length > 0) || result.frames.length > 0) {
          return result
        }
      }
    } catch {
      // try next source
    } finally {
      await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => {})
    }
  }
  return {frames: []}
}

/**
 * Download a compact low-res preview video via yt-dlp into a temporary
 * directory when streaming/section extraction fails or for short clips.
 */
export async function downloadLocalPreviewFile(opts: {
  ytdlpPath: string
  ffmpegPath: string
  infoJsonPath?: string
  videoUrl?: string
  signal?: AbortSignal
}): Promise<{dir: string; filePath: string} | undefined> {
  const sourceArgs = opts.infoJsonPath
    ? [['--load-info-json', opts.infoJsonPath], ...(opts.videoUrl ? [[opts.videoUrl]] : [])]
    : opts.videoUrl
      ? [[opts.videoUrl]]
      : []

  for (const src of sourceArgs) {
    if (opts.signal?.aborted) return undefined
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-preview-'))
    const {signal, cleanup} = linkAbortSignal(opts.signal, DEFAULT_LOCAL_FALLBACK_TIMEOUT_MS)
    try {
      const args = [
        ...src,
        '--no-warnings',
        '--no-playlist',
        '-f',
        'bv*[height<=480]/wv*/bv*/b',
        '--max-filesize',
        '60M',
        '-o',
        path.join(tmpDir, 'preview.%(ext)s'),
      ]
      if (opts.ffmpegPath !== 'ffmpeg') args.push('--ffmpeg-location', opts.ffmpegPath)

      await runYtDlpCommand(opts.ytdlpPath, args, signal)
      const files = (await fs.readdir(tmpDir)).filter(name => !name.endsWith('.part') && !name.endsWith('.ytdl'))
      if (files[0]) {
        return {dir: tmpDir, filePath: path.join(tmpDir, files[0])}
      }
      await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => {})
    } catch {
      await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => {})
    } finally {
      cleanup()
    }
  }
  return undefined
}

/**
 * Extract a short video clip starting at `startSec`. Tries cached local file,
 * fast direct `ffmpeg` stream seeking, and `yt-dlp --download-sections`.
 */
export async function fetchVideoClip(opts: {
  ffmpegPath: string
  ytdlpPath?: string
  infoJsonPath?: string
  videoUrl?: string
  localFilePath?: string
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

  if (opts.localFilePath) {
    const {signal, cleanup} = linkAbortSignal(opts.signal, DEFAULT_STREAM_ATTEMPT_TIMEOUT_MS)
    try {
      for (const seekSec of opts.startSec > 0 ? [opts.startSec, 0] : [0]) {
        const result = await decodeVideoInput({
          ffmpegPath: opts.ffmpegPath,
          input: opts.localFilePath,
          startSec: seekSec,
          clipDurationSec,
          fps,
          pixelWidth,
          pixelHeight,
          mode,
          noColor: opts.noColor,
          signal,
        })
        if (mode === 'kitty' && result.pngFrames && result.pngFrames.length > 0) {
          return {startSec: seekSec, fps, frames: [], pngFrames: result.pngFrames}
        }
        if (result.frames.length > 0) {
          return {startSec: seekSec, fps, frames: result.frames}
        }
      }
    } catch {
      return undefined
    } finally {
      cleanup()
    }
    return undefined
  }

  const candidates = (opts.streams ?? (opts.stream ? [opts.stream] : [])).slice(0, 2)

  for (const stream of candidates) {
    if (opts.signal?.aborted) return undefined
    if (stream.protocol === 'http_dash_segments') continue

    const {signal, cleanup} = linkAbortSignal(opts.signal, DEFAULT_STREAM_ATTEMPT_TIMEOUT_MS)
    try {
      const result = await decodeVideoInput({
        ffmpegPath: opts.ffmpegPath,
        input: stream.url,
        startSec: opts.startSec,
        clipDurationSec,
        fps,
        pixelWidth,
        pixelHeight,
        mode,
        headers: stream.headers,
        noColor: opts.noColor,
        signal,
      })
      if (mode === 'kitty' && result.pngFrames && result.pngFrames.length > 0) {
        return {startSec: opts.startSec, fps, frames: [], pngFrames: result.pngFrames, stream}
      }
      if (result.frames.length > 0) {
        return {startSec: opts.startSec, fps, frames: result.frames, stream}
      }
    } catch {
      if (opts.signal?.aborted) return undefined
    } finally {
      cleanup()
    }
  }

  if (opts.ytdlpPath && (opts.infoJsonPath || opts.videoUrl) && !opts.signal?.aborted) {
    const {signal, cleanup} = linkAbortSignal(opts.signal, DEFAULT_SECTION_TIMEOUT_MS)
    try {
      const result = await fetchSectionViaYtDlp({
        ytdlpPath: opts.ytdlpPath,
        ffmpegPath: opts.ffmpegPath,
        infoJsonPath: opts.infoJsonPath,
        videoUrl: opts.videoUrl,
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
