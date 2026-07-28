import assert from 'node:assert/strict'
import test from 'node:test'
import {__test, galleryChoices} from './gallerydl.js'

test('recognizes Instagram posts and Reels separately', () => {
  assert.equal(__test.isInstagramPost('https://www.instagram.com/p/DbAY89yiZrJ/'), true)
  assert.equal(__test.isInstagramPost('https://www.instagram.com/reel/abc/'), false)
  assert.equal(__test.isInstagramReel('https://www.instagram.com/reel/abc/'), true)
  assert.equal(__test.isInstagramReel('https://www.instagram.com/p/abc/'), false)
})

test('parses gallery-dl JSON messages and classifies mixed media', () => {
  const stdout = JSON.stringify([
    [1, '', {title: 'Example'}],
    [2, 'https://cdn.example/1.jpg', {extension: 'jpg'}],
    [2, 'https://cdn.example/2.mp4', {extension: 'mp4'}],
  ])
  const items = __test.parseGalleryJson(stdout)
  assert.equal(items.length, 2)
  assert.deepEqual(__test.summarizeGallery(items), {
    count: 2,
    imageCount: 1,
    videoCount: 1,
    otherCount: 0,
  })
})

test('builds all, image-only, and video-only choices for mixed posts', () => {
  assert.deepEqual(
    galleryChoices({count: 4, imageCount: 3, videoCount: 1, otherCount: 0}).map(choice => choice.label),
    ['all media · 4 files', 'images only · 3 images', 'videos only · 1 video'],
  )
})
