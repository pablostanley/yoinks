import {spawn} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type {ProbeResult, VideoInfo} from './ytdlp.js'

const OEMBED_BASE = 'https://open.spotify.com/oembed'

type SpotifyOEmbed = {
  title: string
  thumbnail_url?: string
  provider_name: string
}

export function extractSpotifyId(url: string): string | null {
  try {
    const u = new URL(url)
    const match = u.pathname.match(/\/(track|album|playlist|artist)\/([A-Za-z0-9]{22})/)
    return match ? match[2] : null
  } catch {
    return null
  }
}

export async function fetchSpotifyTrackMeta(url: string): Promise<{
  title: string
  thumbnail?: string
  searchQuery: string
}> {
  const resp = await fetch(`${OEMBED_BASE}?url=${encodeURIComponent(url)}`)
  if (!resp.ok) throw new Error(`Spotify oEmbed failed (${resp.status})`)
  const data = (await resp.json()) as SpotifyOEmbed
  const title = data.title
  const thumbnail = data.thumbnail_url
  // use title stripped of " - Remastered YYYY" suffixes for better search
  const cleanTitle = title.replace(/\s*-\s*(Remaster|Remastered|Live|Deluxe|Edition|Version)\s*\d{0,4}$/i, '').trim()
  const searchQuery = `${cleanTitle} audio`
  return {title, thumbnail, searchQuery}
}

export async function spotifyProbe(
  ytdlp: string,
  url: string,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const {title, searchQuery} = await fetchSpotifyTrackMeta(url)

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      ytdlp,
      ['-J', '--no-playlist', '--no-warnings', '-f', 'ba/b', '--prefer-free-formats', `ytsearch1:${searchQuery}`],
      {signal},
    )
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        const err = stderr.trim().split('\n').filter(l => l.includes('ERROR:')).pop() ?? ''
        reject(new Error(err.replace(/^ERROR:\s*/, '') || `No match found for "${title}" on YouTube`))
      } else {
        resolve(out)
      }
    })
  })

  let data: {entries?: unknown[]; _type?: string}
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new Error('Could not parse yt-dlp search results.')
  }

  if (data._type === 'playlist' && data.entries && data.entries.length > 0) {
    const entry = data.entries[0] as VideoInfo
    const infoJsonPath = path.join(os.tmpdir(), `yoinks-info-${process.pid}-${Date.now()}.json`)
    await fs.writeFile(infoJsonPath, JSON.stringify(entry))
    return {info: entry, infoJsonPath}
  }

  throw new Error(`No YouTube result found for "${title}".`)
}
