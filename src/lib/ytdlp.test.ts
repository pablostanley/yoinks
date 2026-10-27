import assert from 'node:assert/strict'
import test from 'node:test'
import {buildChoices, type VideoInfo} from './ytdlp.js'

test('buildChoices generates audio choice with embedded thumbnail and metadata flags', () => {
  const info: VideoInfo = {
    title: 'Test Song',
    uploader: 'Test Artist',
    formats: [
      {format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', abr: 128, filesize: 3_000_000},
      {format_id: '137', ext: 'mp4', vcodec: 'avc1', height: 1080, filesize: 10_000_000},
    ],
  }

  const choices = buildChoices(info)
  const audioChoice = choices.find(c => c.kind === 'audio')
  assert.ok(audioChoice, 'audio choice should be present')
  assert.match(audioChoice.label, /audio only · mp3/)
  assert.ok(audioChoice.args.includes('--embed-thumbnail'), 'audio choice should include --embed-thumbnail')
  assert.ok(audioChoice.args.includes('--embed-metadata'), 'audio choice should include --embed-metadata')
  assert.ok(audioChoice.args.includes('mp3'), 'audio choice should convert to mp3')
})

test('buildChoices includes fallback video choice if no videos found', () => {
  const info: VideoInfo = {
    title: 'Audio Only Media',
    formats: [
      {format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', abr: 128, filesize: 2_000_000},
    ],
  }

  const choices = buildChoices(info)
  const videoChoice = choices.find(c => c.kind === 'video')
  const audioChoice = choices.find(c => c.kind === 'audio')

  assert.ok(videoChoice, 'fallback video choice should be present')
  assert.equal(videoChoice.label, 'best available · mp4')
  assert.ok(audioChoice, 'audio choice should be present')
  assert.ok(audioChoice.args.includes('--embed-thumbnail'))
  assert.ok(audioChoice.args.includes('--embed-metadata'))
})
