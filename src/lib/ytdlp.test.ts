import assert from 'node:assert/strict'
import test from 'node:test'
import {buildChoices} from './ytdlp.js'

const info = {
  formats: [
    {format_id: '140', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128, filesize: 1_000_000, ext: 'm4a'},
    {format_id: '137', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 4000, ext: 'mp4'},
  ],
}

test('the audio choice writes the id3 tags and the cover art into the mp3', () => {
  const choices = buildChoices(info as never)
  const audio = choices.find(choice => choice.kind === 'audio')

  assert.ok(audio, 'expected an audio choice')
  // Without the tags the file only carries the raw filename, so every player
  // shows an empty title.
  assert.ok(audio!.args.includes('--embed-metadata'))
  assert.ok(audio!.args.includes('--embed-thumbnail'))
  // "Artist - Title" titles split into the two tags; yt-dlp falls through
  // silently when the title does not match.
  assert.ok(audio!.args.includes('--parse-metadata'))
  const parseIndex = audio!.args.indexOf('--parse-metadata')
  const metadataIndex = audio!.args.indexOf('--embed-metadata')
  assert.ok(parseIndex < metadataIndex, 'the title is parsed before the tags are written')
})

test('the audio choice still extracts mp3 at the highest bitrate', () => {
  const choices = buildChoices(info as never)
  const audio = choices.find(choice => choice.kind === 'audio')

  assert.ok(audio)
  assert.deepEqual(audio!.args.slice(0, 5), ['-f', 'ba/b', '-x', '--audio-format', 'mp3'])
})
