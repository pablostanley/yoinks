import assert from 'node:assert/strict'
import test from 'node:test'
import {hasPlaylistParam} from './platforms.js'
import {
  buildPlaylistChoices,
  isPlaylistInfo,
  parseAlreadyDownloaded,
  parsePlaylistItem,
  playlistSize,
  type PlaylistInfo,
  type VideoInfo,
} from './ytdlp.js'

test('tells a playlist probe apart from a video probe', () => {
  const playlist = {_type: 'playlist', title: 'mixtape', playlist_count: 12} as PlaylistInfo
  const video = {title: 'one clip', formats: []} as VideoInfo

  assert.equal(isPlaylistInfo(playlist), true)
  assert.equal(isPlaylistInfo(video), false)
})

test('counts entries from whichever field the extractor filled in', () => {
  assert.equal(playlistSize({_type: 'playlist', playlist_count: 40}), 40)
  assert.equal(playlistSize({_type: 'playlist', entries: [{id: 'a'}, {id: 'b'}]}), 2)
  assert.equal(playlistSize({_type: 'playlist'}), 0)
})

test('playlist choices are resolution caps, since entries carry no formats', () => {
  const choices = buildPlaylistChoices()
  const labels = choices.map(c => c.label)

  assert.deepEqual(labels, [
    'best available · mp4',
    'up to 1080p · mp4',
    'up to 720p · mp4',
    'up to 480p · mp4',
    'audio only · mp3',
  ])
  // no exact height= selectors: one item missing that rendition must not fail
  for (const choice of choices) {
    assert.equal(choice.args.join(' ').includes('height='), false)
  }
  assert.equal(choices.at(-1)?.kind, 'audio')
})

test('every capped choice falls back to best available', () => {
  for (const choice of buildPlaylistChoices().filter(c => c.label.startsWith('up to'))) {
    assert.match(choice.args[1]!, /\/bv\*\+ba\/b$/)
  }
})

test('reads the playlist position out of yt-dlp progress output', () => {
  assert.deepEqual(parsePlaylistItem('[download] Downloading item 3 of 12'), {item: 3, totalItems: 12})
  assert.equal(parsePlaylistItem('[download] Downloading playlist: lofi hip hop'), undefined)
  assert.equal(parsePlaylistItem('[info] abc: Downloading 1 format(s): 270+234'), undefined)
})

test('counts a skipped-because-finished item as downloaded, not failed', () => {
  assert.equal(
    parseAlreadyDownloaded('[download] C:\\Users\\me\\Downloads\\mix\\003 - clip.mp4 has already been downloaded'),
    'C:\\Users\\me\\Downloads\\mix\\003 - clip.mp4',
  )
  assert.equal(parseAlreadyDownloaded('[download] Destination: /home/me/clip.mp4'), undefined)
})

test('spots a video url that also points at a playlist', () => {
  assert.equal(hasPlaylistParam('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'), true)
  assert.equal(hasPlaylistParam('https://www.youtube.com/playlist?list=PL123'), true)
  assert.equal(hasPlaylistParam('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false)
  assert.equal(hasPlaylistParam('https://youtu.be/dQw4w9WgXcQ'), false)
  assert.equal(hasPlaylistParam('not a url'), false)
})
