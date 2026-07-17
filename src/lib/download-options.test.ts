import assert from 'node:assert/strict'
import test from 'node:test'
import {DEFAULT_DOWNLOAD_OPTIONS, setDownloadOption} from './download-options.js'

test('returns a new options value without mutating the prior value', () => {
  const enabled = setDownloadOption(DEFAULT_DOWNLOAD_OPTIONS, 'embedChapters', true)

  assert.notEqual(enabled, DEFAULT_DOWNLOAD_OPTIONS)
  assert.deepEqual(DEFAULT_DOWNLOAD_OPTIONS, {embedChapters: false})
  assert.deepEqual(enabled, {embedChapters: true})
})
