import assert from 'node:assert/strict'
import test from 'node:test'
import {buildChoices, expectedSha256, isExpiredLinkError} from './ytdlp.js'

test('builds one mp4 choice per height plus mp3, best first', () => {
  const choices = buildChoices({
    title: 'x',
    formats: [
      {format_id: '1', vcodec: 'avc1', acodec: 'none', height: 720, ext: 'mp4', filesize: 1000},
      {format_id: '2', vcodec: 'vp9', acodec: 'none', height: 1080, ext: 'webm'},
      {format_id: '3', vcodec: 'none', acodec: 'opus', abr: 128, filesize: 100},
    ],
  })
  assert.deepEqual(
    choices.map(c => c.kind),
    ['video', 'video', 'audio'],
  )
  assert.match(choices[0]!.label, /^1080p/)
  assert.match(choices[1]!.label, /^720p/)
})

test('falls back to best available when no heights are known', () => {
  const choices = buildChoices({title: 'x', formats: []})
  assert.equal(choices[0]!.label, 'best available · mp4')
  assert.equal(choices.at(-1)!.kind, 'audio')
})

test('only link-expiry failures are retried', () => {
  assert.equal(isExpiredLinkError(new Error('unable to download video data: HTTP Error 403: Forbidden')), true)
  assert.equal(isExpiredLinkError(new Error('No space left on device')), false)
  assert.equal(isExpiredLinkError(new Error('Postprocessing: ffmpeg exited with code 1')), false)
})

test('reads the checksum for the right asset', () => {
  const sums = 'aaa  yt-dlp\nBBB  yt-dlp.exe\nccc  yt-dlp_macos\n'
  assert.equal(expectedSha256(sums, 'yt-dlp.exe'), 'bbb')
  assert.equal(expectedSha256(sums, 'yt-dlp_linux'), undefined)
})
