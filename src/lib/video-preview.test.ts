import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  downloadLocalPreviewFile,
  fetchThumbnailFrame,
  fetchThumbnailGraphic,
  fetchVideoClip,
  hasVideoContent,
  isVideoFormat,
  parseCookieHeader,
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
  assert.equal(streams[1]?.formatId, '133')
})

test('hasVideoContent returns false for audio-only metadata', () => {
  const info: VideoInfo = {
    title: 'Audio Track',
    formats: [{format_id: 'm4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', url: 'https://ex/a.m4a'}],
  }
  assert.equal(pickPreviewStream(info), undefined)
  assert.equal(hasVideoContent(info), false)
})

test('isVideoFormat and pickPreviewStreams accept streams with omitted vcodec (e.g. Instagram/TikTok/X)', () => {
  const socialInfo: VideoInfo = {
    title: 'Social Clip',
    formats: [
      {format_id: 'mp4-sd', ext: 'mp4', height: 480, protocol: 'https', url: 'https://cdn.ex/clip.mp4'},
      {format_id: 'audio', ext: 'mp3', acodec: 'mp3', url: 'https://cdn.ex/a.mp3'},
    ],
  }
  assert.equal(isVideoFormat(socialInfo.formats![0]!), true)
  assert.equal(isVideoFormat(socialInfo.formats![1]!), false)
  assert.equal(hasVideoContent(socialInfo), true)
  assert.equal(pickPreviewStream(socialInfo)?.formatId, 'mp4-sd')

  // When formats array is empty on single-stream extractors, still treat webpage_url as video candidate
  assert.equal(hasVideoContent({title: 'Generic', webpage_url: 'https://example.com/v', formats: []}), true)

  assert.equal(
    parseCookieHeader('ttwid=abc; Domain=.tiktok.com; Path=/; Secure; Expires=123; tt_chain_token="xyz"; HttpOnly'),
    'ttwid=abc; tt_chain_token="xyz"',
  )
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

      // Verify sanitized headers strip Host/Content-Length without crashing fetch
      const thumbWithBadHeaders = await fetchThumbnailGraphic({
        ffmpegPath,
        info: {
          ...info,
          http_headers: {Host: 'bad.invalid', 'Content-Length': '999', 'User-Agent': 'test-agent'},
        },
        dims: {cols: 16, rows: 5},
        mode: 'halfblock',
      })
      assert.ok(thumbWithBadHeaders?.lines)

      // Verify yt-dlp fallback for thumbnails, sections, and local preview file download
      const infoJsonPath = path.join(tmpDir, 'info.json')
      await fs.writeFile(infoJsonPath, JSON.stringify(info))
      const mockYtDlp = path.join(tmpDir, 'mock-ytdlp.mjs')
      await fs.writeFile(
        mockYtDlp,
        `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const tpl = outIdx !== -1 ? args[outIdx + 1] : '';
if (args.includes('--write-thumbnail')) {
  fs.copyFileSync(${JSON.stringify(thumbPath)}, tpl.replace('%(ext)s', 'png'));
} else {
  fs.copyFileSync(${JSON.stringify(videoPath)}, tpl.replace('%(ext)s', 'mp4'));
}
`,
      )
      await fs.chmod(mockYtDlp, 0o755)

      const fallbackThumb = await fetchThumbnailGraphic({
        ffmpegPath,
        ytdlpPath: mockYtDlp,
        infoJsonPath,
        info: {title: 'Blocked Thumb', thumbnail: 'http://127.0.0.1:1/404.png'},
        dims: {cols: 16, rows: 5},
        mode: 'halfblock',
      })
      assert.ok(fallbackThumb?.lines && fallbackThumb.lines.length === 5)

      const fallbackSectionClip = await fetchVideoClip({
        ffmpegPath,
        ytdlpPath: mockYtDlp,
        infoJsonPath,
        streams: [{formatId: 'bad', url: 'http://127.0.0.1:1/403.mp4', protocol: 'https'}],
        startSec: 1.0,
        clipDurationSec: 0.8,
        fps: 10,
        dims: {cols: 16, rows: 5},
        mode: 'halfblock',
      })
      assert.ok(fallbackSectionClip && fallbackSectionClip.frames.length >= 5)

      const local = await downloadLocalPreviewFile({
        ytdlpPath: mockYtDlp,
        ffmpegPath,
        infoJsonPath,
      })
      assert.ok(local)
      try {
        // Seeking past video duration cleanly falls back to 0s on local file
        const localClip = await fetchVideoClip({
          ffmpegPath,
          localFilePath: local.filePath,
          startSec: 99,
          clipDurationSec: 0.8,
          fps: 10,
          dims: {cols: 16, rows: 5},
          mode: 'halfblock',
        })
        assert.ok(localClip && localClip.frames.length >= 5)
        assert.equal(localClip.startSec, 0)
      } finally {
        await fs.rm(local.dir, {recursive: true, force: true})
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true})
  }
})
