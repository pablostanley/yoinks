import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  fetchThumbnailFrame,
  fetchThumbnailGraphic,
  fetchVideoClip,
  hasVideoContent,
  pickPreviewStream,
  pickPreviewStreams,
  pickRandomClipTimestamp,
  pickThumbnailUrls,
  renderRgbFrameToLines,
} from './video-preview.js'
import {resolveFfmpegExecutable, type VideoInfo} from './ytdlp.js'

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

test('pickThumbnailUrls prefers medium image thumbnails and filters storyboards', () => {
  const info: VideoInfo = {
    title: 'Sample',
    thumbnail: 'https://cdn.example.com/fallback.jpg',
    thumbnails: [
      {id: 'sb0', url: 'https://cdn.example.com/storyboard.mhtml', width: 320},
      {id: 'tiny', url: 'https://cdn.example.com/120.jpg', width: 120},
      {id: 'hd', url: 'https://cdn.example.com/1920.jpg', width: 1920},
      {id: 'med', url: 'https://cdn.example.com/320.jpg', width: 320},
      {id: 'med-webp', url: 'https://cdn.example.com/360.webp', width: 360},
    ],
  }

  const urls = pickThumbnailUrls(info)
  assert.equal(urls[0], 'https://cdn.example.com/320.jpg')
  assert.equal(urls[1], 'https://cdn.example.com/360.webp')
  assert.ok(!urls.some(u => u.includes('storyboard.mhtml')))
  assert.equal(urls.at(-1), 'https://cdn.example.com/fallback.jpg')
})

test('pickPreviewStream picks a low-res progressive stream over 4K or HLS', () => {
  const info: VideoInfo = {
    title: 'Sample',
    formats: [
      {format_id: '4k', ext: 'mp4', vcodec: 'av01', height: 2160, protocol: 'https', url: 'https://ex/4k.mp4'},
      {format_id: 'hls', ext: 'mp4', vcodec: 'avc1', height: 240, protocol: 'm3u8_native', url: 'https://ex/240.m3u8'},
      {format_id: '240p', ext: 'mp4', vcodec: 'avc1.4d', height: 240, protocol: 'https', url: 'https://ex/240.mp4'},
      {format_id: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', protocol: 'https', url: 'https://ex/a.m4a'},
    ],
  }

  const stream = pickPreviewStream(info)
  assert.equal(stream?.formatId, '240p')
  assert.equal(stream?.url, 'https://ex/240.mp4')
  assert.equal(hasVideoContent(info), true)
})

test('pickPreviewStreams prefers HLS m3u8_native on YouTube and keeps progressive fallback', () => {
  const ytInfo: VideoInfo = {
    title: 'YouTube Video',
    extractor_key: 'Youtube',
    formats: [
      {format_id: '133', ext: 'mp4', vcodec: 'avc1', height: 240, protocol: 'https', url: 'https://ex/133.mp4'},
      {format_id: '229', ext: 'mp4', vcodec: 'avc1', height: 240, protocol: 'm3u8_native', url: 'https://ex/229.m3u8'},
      {format_id: '269', ext: 'mp4', vcodec: 'avc1', height: 144, protocol: 'm3u8_native', url: 'https://ex/269.m3u8'},
    ],
  }

  const streams = pickPreviewStreams(ytInfo)
  assert.equal(streams[0]?.formatId, '229')
  assert.equal(streams[1]?.formatId, '269')
  assert.equal(streams[2]?.formatId, '133')
})

test('hasVideoContent returns false for audio-only metadata', () => {
  const info: VideoInfo = {
    title: 'Audio Track',
    formats: [{format_id: 'm4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', url: 'https://ex/a.m4a'}],
  }
  assert.equal(pickPreviewStream(info), undefined)
  assert.equal(hasVideoContent(info), false)
})

test('pickRandomClipTimestamp respects short durations and avoids repeating recent timestamps', () => {
  assert.equal(pickRandomClipTimestamp(undefined, 2.5), 0)
  assert.equal(pickRandomClipTimestamp(2, 2.5), 0)

  const recent: number[] = []
  for (let i = 0; i < 6; i++) {
    const t = pickRandomClipTimestamp(200, 2.5, recent)
    assert.ok(t >= 10 && t <= 186, `timestamp ${t} out of expected [10, 186] range`)
    for (const prev of recent) {
      assert.ok(Math.abs(t - prev) >= 5, `timestamp ${t} too close to ${prev}`)
    }
    recent.push(t)
  }
})

test('renderRgbFrameToLines encodes half-block ANSI and ASCII fallback cleanly', () => {
  // 2x4 RGB image (2 cols x 2 half-block rows):
  // Row 0 top=(255,0,0),(255,0,0) bottom=(0,255,0),(0,255,0)
  // Row 1 top=(0,0,255),(255,255,255) bottom=(0,0,0),(255,255,255)
  const rgb = new Uint8Array([
    255, 0, 0, 255, 0, 0,
    0, 255, 0, 0, 255, 0,
    0, 0, 255, 255, 255, 255,
    0, 0, 0, 255, 255, 255,
  ])

  const colorLines = renderRgbFrameToLines(rgb, 2, 4, {noColor: false})
  assert.equal(colorLines.length, 2)
  assert.equal(stripAnsi(colorLines[0]!), '▀▀')
  assert.equal(stripAnsi(colorLines[1]!), '▀▀')
  assert.match(colorLines[0]!, /\x1b\[38;2;255;0;0;48;2;0;255;0m▀▀\x1b\[0m/)

  const asciiLines = renderRgbFrameToLines(rgb, 2, 4, {noColor: true})
  assert.equal(asciiLines.length, 2)
  assert.equal(asciiLines[0]!.length, 2)
  assert.equal(asciiLines[1]!.length, 2)
  assert.equal(asciiLines[1]![1], '@') // white pixel pair -> brightest ramp char
})

test('fetchThumbnailFrame and fetchVideoClip decode real media with ffmpeg', async t => {
  const ffmpegPath = await resolveFfmpegExecutable()
  if (!ffmpegPath) {
    t.skip('ffmpeg executable not available')
    return
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-preview-test-'))
  const videoPath = path.join(tmpDir, 'sample.mp4')
  const thumbPath = path.join(tmpDir, 'thumb.png')

  try {
    // Generate a 5-second testsrc video (counts up seconds visually) and thumbnail image
    const vid = spawnSync(ffmpegPath, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=5:size=160x90:rate=10',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ])
    assert.equal(vid.status, 0, `ffmpeg failed generating video: ${vid.stderr?.toString()}`)

    const img = spawnSync(ffmpegPath, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=160x90:d=1',
      '-frames:v',
      '1',
      thumbPath,
    ])
    assert.equal(img.status, 0, `ffmpeg failed generating thumbnail: ${img.stderr?.toString()}`)

    const pngBytes = await fs.readFile(thumbPath)
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {'Content-Type': 'image/png'})
      res.end(pngBytes)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')

    try {
      const info: VideoInfo = {
        title: 'Test Video',
        duration: 5,
        thumbnail: `http://127.0.0.1:${addr.port}/thumb.png`,
        formats: [{format_id: 'local', ext: 'mp4', vcodec: 'h264', height: 90, url: videoPath}],
      }

      const thumb = await fetchThumbnailFrame({
        ffmpegPath,
        info,
        dims: {cols: 16, rows: 5},
        noColor: false,
      })
      assert.ok(thumb)
      assert.equal(thumb.length, 5)
      assert.equal(stripAnsi(thumb[0]!).length, 16)
      assert.match(thumb[0]!, /38;2;25[0-5];/) // red channel dominant

      const clipA = await fetchVideoClip({
        ffmpegPath,
        stream: pickPreviewStream(info),
        startSec: 0.2,
        clipDurationSec: 1.0,
        fps: 10,
        dims: {cols: 16, rows: 5},
        noColor: false,
      })
      const clipB = await fetchVideoClip({
        ffmpegPath,
        stream: pickPreviewStream(info),
        startSec: 3.2,
        clipDurationSec: 1.0,
        fps: 10,
        dims: {cols: 16, rows: 5},
        noColor: false,
      })

      assert.ok(clipA && clipA.frames.length >= 5)
      assert.ok(clipB && clipB.frames.length >= 5)
      assert.equal(stripAnsi(clipA.frames[0]![0]!).length, 16)
      assert.notDeepEqual(clipA.frames[0], clipB.frames[0])

      // Also verify Kitty mode outputs crisp high-res PNGs
      const kittyThumb = await fetchThumbnailGraphic({
        ffmpegPath,
        info,
        dims: {cols: 32, rows: 9},
        mode: 'kitty',
      })
      assert.ok(kittyThumb?.png && kittyThumb.png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))

      const kittyClip = await fetchVideoClip({
        ffmpegPath,
        streams: pickPreviewStreams(info),
        startSec: 0.2,
        clipDurationSec: 0.8,
        fps: 10,
        dims: {cols: 32, rows: 9},
        mode: 'kitty',
      })
      assert.ok(kittyClip?.pngFrames && kittyClip.pngFrames.length >= 5)
      assert.ok(kittyClip.pngFrames[0]!.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true})
  }
})
