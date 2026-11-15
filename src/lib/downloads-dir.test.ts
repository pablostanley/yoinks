import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {pickDownloadsDir} from './downloads-dir.js'

// resolved so the fixtures are absolute on whichever platform runs the tests
const home = path.resolve('/home/pablo')
const fallback = path.join(home, 'Downloads')

test('uses the folder the system reports, even outside the home folder', () => {
  const moved = path.resolve('/mnt/media/Downloads')
  assert.equal(pickDownloadsDir(`${moved}\r\n`, home), moved)
  assert.equal(pickDownloadsDir(`${moved}\n`, home), moved)
})

test('falls back to ~/Downloads when the system has no usable answer', () => {
  assert.equal(pickDownloadsDir('', home), fallback)
  assert.equal(pickDownloadsDir('\n', home), fallback)
  assert.equal(pickDownloadsDir('Downloads', home), fallback)
})

test('does not save into the home folder itself when no downloads dir is configured', () => {
  // xdg-user-dir prints $HOME for an unset directory
  assert.equal(pickDownloadsDir(`${home}\n`, home), fallback)
  assert.equal(pickDownloadsDir(`${home}${path.sep}\n`, home), fallback)
})
