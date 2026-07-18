import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {saveAsOutputTemplate, validateSaveAs} from './save-as.js'

test('uses the original title template when no save-as name is supplied', () => {
  assert.equal(saveAsOutputTemplate('/downloads', undefined), path.join('/downloads', '%(title).60s.%(ext)s'))
})

test('uses the requested name while keeping the selected format extension', () => {
  assert.equal(saveAsOutputTemplate('/downloads', 'my clip'), path.join('/downloads', 'my clip.%(ext)s'))
  assert.equal(saveAsOutputTemplate('/downloads', 'song.mp3'), path.join('/downloads', 'song.%(ext)s'))
  assert.equal(saveAsOutputTemplate('/downloads', 'clip.mp4'), path.join('/downloads', 'clip.%(ext)s'))
})

test('escapes yt-dlp template characters and rejects paths', () => {
  assert.equal(saveAsOutputTemplate('/downloads', '100% mine'), path.join('/downloads', '100%% mine.%(ext)s'))
  assert.match(validateSaveAs('../clip') ?? '', /cannot contain/)
  assert.match(validateSaveAs('clip/name') ?? '', /cannot contain/)
  assert.match(validateSaveAs('CON') ?? '', /reserved/)
})
