import assert from 'node:assert/strict'
import test from 'node:test'
import {DEFAULT_DOWNLOAD_OPTIONS} from './download-options.js'
import {buildDownloadArgs, type DownloadChoice} from './ytdlp.js'

const choice: DownloadChoice = {
  kind: 'video',
  label: 'best available · mp4',
  args: ['-f', 'bv*+ba/b'],
}

test('adds embed-chapters only when the download preference is enabled', () => {
  const base = {
    url: 'https://example.com/video',
    choice,
    downloadOptions: DEFAULT_DOWNLOAD_OPTIONS,
    outDir: '/downloads',
  }

  assert.equal(buildDownloadArgs(base).includes('--embed-chapters'), false)
  assert.ok(buildDownloadArgs({...base, downloadOptions: {embedChapters: true}}).includes('--embed-chapters'))
})
