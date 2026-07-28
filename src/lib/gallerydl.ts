import {spawn, type ChildProcess} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const YOINKS_ROOT = path.join(os.homedir(), '.yoinks')
const GALLERYDL_ENV_DIR = path.join(YOINKS_ROOT, 'gallery-dl')

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'jxl', 'png', 'tif', 'tiff', 'webp'])
const VIDEO_EXTENSIONS = new Set(['avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ts', 'webm', 'wmv'])

export type GalleryMode = 'all' | 'images' | 'videos'

export type GallerySummary = {
  count: number
  imageCount: number
  videoCount: number
  otherCount: number
}

export type GalleryProbe = {
  title: string
  uploader?: string
  summary: GallerySummary
}

type GalleryItem = {url: string; extension?: string; metadata: Record<string, unknown>}
type PythonCommand = {cmd: string; prefix: string[]}

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
    child.on('close', (code: number | null) => resolve(code === 0))
  })
}

function runCommand(cmd: string, args: string[], signal?: AbortSignal): Promise<{stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {signal})
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code: number | null) => {
      if (code === 0) resolve({stdout, stderr})
      else reject(new Error(cleanGalleryDlError(stderr) || `${path.basename(cmd)} exited with code ${code}`))
    })
  })
}

async function findPython(): Promise<PythonCommand | undefined> {
  const candidates: PythonCommand[] =
    process.platform === 'win32'
      ? [
          {cmd: 'py', prefix: ['-3']},
          {cmd: 'python3', prefix: []},
          {cmd: 'python', prefix: []},
        ]
      : [
          {cmd: 'python3', prefix: []},
          {cmd: 'python', prefix: []},
        ]

  for (const candidate of candidates) {
    if (await commandWorks(candidate.cmd, [...candidate.prefix, '--version'])) return candidate
  }
  return undefined
}

function galleryDlPaths(): {executable: string; python: string} {
  if (process.platform === 'win32') {
    return {
      executable: path.join(GALLERYDL_ENV_DIR, 'Scripts', 'gallery-dl.exe'),
      python: path.join(GALLERYDL_ENV_DIR, 'Scripts', 'python.exe'),
    }
  }
  return {
    executable: path.join(GALLERYDL_ENV_DIR, 'bin', 'gallery-dl'),
    python: path.join(GALLERYDL_ENV_DIR, 'bin', 'python'),
  }
}

/**
 * Prefer a system/Homebrew install. If it is missing, install gallery-dl into
 * a private venv under ~/.yoinks so users still invoke a single `yoinks` CLI.
 */
async function ensureGalleryDl(signal?: AbortSignal): Promise<string> {
  if (await commandWorks('gallery-dl', ['--version'])) return 'gallery-dl'

  const local = galleryDlPaths()
  if (await commandWorks(local.executable, ['--version'])) return local.executable

  const python = await findPython()
  if (!python) {
    throw new Error(
      'This link needs gallery-dl. Install it with “brew install gallery-dl” (macOS/Linux) or install Python 3, then try again.',
    )
  }

  await fs.mkdir(YOINKS_ROOT, {recursive: true})
  await fs.rm(GALLERYDL_ENV_DIR, {recursive: true, force: true})

  try {
    await runCommand(python.cmd, [...python.prefix, '-m', 'venv', GALLERYDL_ENV_DIR], signal)
    await runCommand(
      local.python,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'gallery-dl'],
      signal,
    )
  } catch (error) {
    throw new Error(
      `Could not install gallery-dl automatically. Run “brew install gallery-dl” and retry. ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  if (!(await commandWorks(local.executable, ['--version']))) {
    throw new Error('gallery-dl was installed but could not be started. Run “brew install gallery-dl” and retry.')
  }
  return local.executable
}

export function isInstagramPost(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return (host === 'instagram.com' || host.endsWith('.instagram.com')) && /^\/p\//.test(parsed.pathname)
  } catch {
    return false
  }
}

export function isInstagramReel(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return (host === 'instagram.com' || host.endsWith('.instagram.com')) && /^\/(reel|reels|tv)\//.test(parsed.pathname)
  } catch {
    return false
  }
}

function metadataString(metadata: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function nestedMetadataString(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  return metadataString(value as Record<string, unknown>, ['username', 'name', 'account', 'id'])
}

function extensionFromUrl(value: string): string | undefined {
  try {
    const ext = path.extname(new URL(value).pathname).slice(1).toLowerCase()
    return ext || undefined
  } catch {
    const ext = path.extname(value.split('?')[0] ?? '').slice(1).toLowerCase()
    return ext || undefined
  }
}

function collectGalleryItems(value: unknown, items: GalleryItem[]): void {
  if (Array.isArray(value)) {
    // gallery-dl JSON protocol: [2, directUrl, metadata] is a downloadable file.
    if (value[0] === 2 && typeof value[1] === 'string') {
      const metadata = value[2] && typeof value[2] === 'object' ? (value[2] as Record<string, unknown>) : {}
      const extension = metadataString(metadata, ['extension'])?.toLowerCase() ?? extensionFromUrl(value[1])
      items.push({url: value[1], extension, metadata})
      return
    }
    for (const child of value) collectGalleryItems(child, items)
    return
  }

  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) collectGalleryItems(child, items)
  }
}

function parseGalleryJson(stdout: string): GalleryItem[] {
  const items: GalleryItem[] = []
  const trimmed = stdout.trim()
  if (!trimmed) return items

  try {
    collectGalleryItems(JSON.parse(trimmed), items)
  } catch {
    for (const line of trimmed.split('\n')) {
      try {
        collectGalleryItems(JSON.parse(line), items)
      } catch {
        // Diagnostics are emitted on stderr; ignore non-JSON stdout lines.
      }
    }
  }

  const seen = new Set<string>()
  return items.filter(item => {
    if (seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
}

function summarizeGallery(items: GalleryItem[]): GallerySummary {
  let imageCount = 0
  let videoCount = 0
  for (const item of items) {
    if (item.extension && IMAGE_EXTENSIONS.has(item.extension)) imageCount++
    else if (item.extension && VIDEO_EXTENSIONS.has(item.extension)) videoCount++
  }
  return {count: items.length, imageCount, videoCount, otherCount: items.length - imageCount - videoCount}
}

function galleryTitle(items: GalleryItem[], url: string): string {
  for (const item of items) {
    const title = metadataString(item.metadata, ['title', 'description', 'caption', 'shortcode', 'post_id', 'id'])
    if (title) return title.replace(/\s+/g, ' ').slice(0, 120)
  }
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '')
  } catch {
    return url
  }
}

function galleryUploader(items: GalleryItem[]): string | undefined {
  for (const item of items) {
    const direct = metadataString(item.metadata, ['username', 'user', 'author', 'account'])
    if (direct) return direct
    for (const key of ['owner', 'user', 'author']) {
      const nested = nestedMetadataString(item.metadata[key])
      if (nested) return nested
    }
  }
  return undefined
}

export async function probeGallery(url: string, signal?: AbortSignal): Promise<GalleryProbe> {
  const gallerydl = await ensureGalleryDl(signal)
  const {stdout} = await runCommand(
    gallerydl,
    ['--dump-json', '--simulate', '--no-input', '--no-colors', url],
    signal,
  )
  const items = parseGalleryJson(stdout)
  if (items.length === 0) throw new Error('gallery-dl found no downloadable media at this link.')

  return {
    title: galleryTitle(items, url),
    uploader: galleryUploader(items),
    summary: summarizeGallery(items),
  }
}

export function galleryChoices(summary: GallerySummary): Array<{label: string; mode: GalleryMode}> {
  const plural = (count: number, singular: string) => `${count} ${singular}${count === 1 ? '' : 's'}`

  if (summary.imageCount > 0 && summary.videoCount > 0) {
    return [
      {label: `all media · ${plural(summary.count, 'file')}`, mode: 'all'},
      {label: `images only · ${plural(summary.imageCount, 'image')}`, mode: 'images'},
      {label: `videos only · ${plural(summary.videoCount, 'video')}`, mode: 'videos'},
    ]
  }
  if (summary.imageCount > 0) {
    return [{label: `${plural(summary.imageCount, 'image')} · original files`, mode: 'images'}]
  }
  if (summary.videoCount > 0) {
    return [{label: `${plural(summary.videoCount, 'video')} · original files`, mode: 'videos'}]
  }
  return [{label: `${plural(summary.count, 'file')} · original files`, mode: 'all'}]
}

function safePathSegment(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  return (cleaned || 'gallery').slice(0, 80)
}

function galleryOutputDir(url: string, outDir: string): string {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const id = parts.at(-1)
    const host = parsed.hostname.replace(/^www\./, '').split('.')[0] || 'gallery'
    return path.join(outDir, safePathSegment(`${host}-${id || 'gallery'}`))
  } catch {
    return path.join(outDir, `gallery-${Date.now()}`)
  }
}

function galleryFilter(mode: GalleryMode): string[] {
  if (mode === 'all') return []
  const extensions = [...(mode === 'images' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS)]
    .sort()
    .map(ext => `'${ext}'`)
    .join(', ')
  return ['--filter', `extension and extension.lower() in (${extensions})`]
}

function withYtDlpOnPath(ytdlp: string): NodeJS.ProcessEnv {
  if (!path.isAbsolute(ytdlp)) return process.env
  return {
    ...process.env,
    PATH: `${path.dirname(ytdlp)}${path.delimiter}${process.env.PATH ?? ''}`,
  }
}

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild?.kill('SIGTERM'))

export function downloadGallery(
  opts: {ytdlp: string; url: string; mode: GalleryMode; outDir: string},
  onProcessing: () => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const gallerydl = await ensureGalleryDl(signal)
        const targetDir = galleryOutputDir(opts.url, opts.outDir)
        await fs.mkdir(targetDir, {recursive: true})
        onProcessing()

        const args = [
          '--no-input',
          '--no-colors',
          '-D',
          targetDir,
          '--Print',
          'after:{_path}',
          '--Print',
          'skip:{_path}',
          ...galleryFilter(opts.mode),
          opts.url,
        ]
        const child = spawn(gallerydl, args, {signal, env: withYtDlpOnPath(opts.ytdlp)})
        activeChild = child
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
        child.on('error', reject)
        child.on('close', (code: number | null) => {
          activeChild = undefined
          if (signal?.aborted) {
            reject(new Error('Download cancelled.'))
            return
          }
          if (code === 0) resolve(targetDir)
          else reject(new Error(cleanGalleryDlError(stderr) || `gallery-dl exited with code ${code}`))
        })
      } catch (error) {
        reject(error)
      }
    })()
  })
}

function cleanGalleryDlError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const last = lines.filter(line => /\[(error|warning)\]/i.test(line)).at(-1) ?? lines.at(-1)
  return last?.replace(/^\[[^\]]+\]\[(?:error|warning)\]\s*/i, '') ?? ''
}

/** Internal pure helpers exposed only for regression tests. */
export const __test = {
  isInstagramPost,
  isInstagramReel,
  parseGalleryJson,
  summarizeGallery,
}
