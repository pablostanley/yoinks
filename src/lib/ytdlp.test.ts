import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {buildChoices, download, type DownloadChoice, type VideoInfo} from './ytdlp.js'

const choice: DownloadChoice = {label: 'best', kind: 'video', args: []}
const noop = {onProgress: () => {}, onProcessing: () => {}}

/** A fake yt-dlp that saves to "clip.mp4" and then runs `body`. */
async function fakeYtDlp(dir: string, body: string): Promise<string> {
  const bin = path.join(dir, 'fake-yt-dlp')
  await fs.writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const out = args[args.indexOf('-o') + 1].replace('%(title).60s', 'clip').replace('%(ext)s', 'mp4')
${body}
`,
    {mode: 0o755},
  )
  return bin
}

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-test-'))

test('a same-named file in the output folder is kept and the new download gets a free name', {skip: process.platform === 'win32'}, async () => {
  const dir = await tempDir()
  const outDir = path.join(dir, 'Downloads')
  await fs.mkdir(outDir)
  await fs.writeFile(path.join(outDir, 'clip.mp4'), 'an earlier, different video')
  const ytdlp = await fakeYtDlp(dir, `fs.writeFileSync(out, 'the video you just picked'); console.log(out)`)

  const filepath = await download({ytdlp, url: 'https://example.com/clip.mp4', choice, outDir}, noop)

  assert.equal(filepath, path.join(outDir, 'clip (1).mp4'))
  assert.equal(await fs.readFile(filepath, 'utf8'), 'the video you just picked')
  assert.equal(await fs.readFile(path.join(outDir, 'clip.mp4'), 'utf8'), 'an earlier, different video')
  assert.deepEqual((await fs.readdir(outDir)).sort(), ['clip (1).mp4', 'clip.mp4'])
  await fs.rm(dir, {recursive: true, force: true})
})

test('cancelling stops right away and leaves no partial files', {skip: process.platform === 'win32', timeout: 3000}, async () => {
  const dir = await tempDir()
  const outDir = path.join(dir, 'Downloads')
  const pidFile = path.join(dir, 'helper.pid')
  // the helper outlives yt-dlp and keeps its output pipe open, like ffmpeg can
  const ytdlp = await fakeYtDlp(
    dir,
    `fs.writeFileSync(out + '.part', 'half a video')
const helper = require('node:child_process').spawn('sleep', ['10'], {stdio: 'inherit'})
fs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid))
console.log('YOINK|6|12|NA|NA|NA')
setInterval(() => {}, 1000)`,
  )
  const controller = new AbortController()

  await assert.rejects(
    download(
      {ytdlp, url: 'https://example.com/clip.mp4', choice, outDir},
      {...noop, onProgress: () => controller.abort()},
      controller.signal,
    ),
    /cancelled/,
  )

  assert.deepEqual(await fs.readdir(outDir), [])
  process.kill(Number(await fs.readFile(pidFile, 'utf8')))
  await fs.rm(dir, {recursive: true, force: true})
})

const MB = 1024 * 1024
// like YouTube: H.264 up to 1080p (plus an HLS copy with no size), AV1 and VP9 above
const youtubeLike: VideoInfo = {
  title: 'clip',
  duration: 10,
  formats: [
    {format_id: '401', vcodec: 'av01.0.12M.08', acodec: 'none', height: 2160, tbr: 12_000, filesize: 20 * MB},
    {format_id: '313', vcodec: 'vp9', acodec: 'none', height: 2160, tbr: 18_000, filesize: 25 * MB},
    {format_id: '137', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 4_000, filesize: 8 * MB},
    {format_id: '270', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 4_500},
    {format_id: '399', vcodec: 'av01.0.08M.08', acodec: 'none', height: 1080, tbr: 2_000, filesize: 4 * MB},
    {format_id: '248', vcodec: 'vp9', acodec: 'none', height: 1080, tbr: 3_000, filesize: 5 * MB},
    {format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, filesize: 1 * MB},
    {format_id: '251', vcodec: 'none', acodec: 'opus', abr: 135, filesize: 2 * MB},
  ],
}

test('video choices ask for H.264, then AV1, with AAC audio before anything else', () => {
  const [, p1080] = buildChoices(youtubeLike)
  const selector = p1080!.args[p1080!.args.indexOf('-f') + 1]!
  assert.ok(
    selector.startsWith(
      "bv*[height=1080][vcodec~='^(avc|h264)']+(ba[acodec^=mp4a]/ba)" +
        '/bv*[height=1080][vcodec^=av01]+(ba[acodec^=mp4a]/ba)' +
        '/bv*[height=1080]+ba/',
    ),
    selector,
  )
})

test('size estimates describe the streams that get downloaded', () => {
  const labels = buildChoices(youtubeLike).map(choice => choice.label)
  assert.deepEqual(labels, [
    '2160p · mp4 · ~21 MB', // AV1 + AAC
    '1080p · mp4 · ~9.0 MB', // H.264 + AAC
    'audio only · mp3 · ~2.0 MB',
  ])
})

test('a video row with an unknown size shows no estimate rather than the audio size', () => {
  const [p720] = buildChoices({
    title: 'clip',
    formats: [
      {format_id: 'hls-720', vcodec: 'avc1', acodec: 'none', height: 720},
      {format_id: 'audio', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: MB},
    ],
  })
  assert.equal(p720!.label, '720p · mp4')
})
