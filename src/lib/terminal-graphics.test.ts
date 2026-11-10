import assert from 'node:assert/strict'
import test from 'node:test'
import {
  encodeKittyDelete,
  encodeKittyPngDisplay,
  encodeKittyRePlace,
  splitPngStream,
} from './terminal-graphics.js'

test('encodeKittyPngDisplay emits single-chunk and multi-chunk APC frames cleanly', () => {
  const small = Buffer.from('tiny-png')
  const single = encodeKittyPngDisplay(small, {id: 42, placementId: 1, cols: 40, rows: 11})
  assert.equal(single, `\x1b_Ga=T,f=100,i=42,p=1,c=40,r=11,C=1,q=2;${small.toString('base64')}\x1b\\`)

  const large = Buffer.alloc(6000, 0x41)
  const multi = encodeKittyPngDisplay(large, {id: 42, placementId: 1, cols: 40, rows: 11})
  assert.match(multi, /^\x1b_Ga=T,f=100,i=42,p=1,c=40,r=11,C=1,q=2,m=1;/)
  assert.match(multi, /\x1b_Gm=0;[A-Za-z0-9+/=]+\x1b\\$/)
})

test('encodeKittyRePlace and encodeKittyDelete produce expected quiet control sequences', () => {
  assert.equal(
    encodeKittyRePlace({id: 42, placementId: 1, cols: 40, rows: 11}),
    '\x1b_Ga=p,i=42,p=1,c=40,r=11,C=1,q=2\x1b\\',
  )
  assert.equal(encodeKittyDelete(42), '\x1b_Ga=d,d=I,i=42,q=2\x1b\\')
  assert.equal(encodeKittyDelete(), '\x1b_Ga=d,d=A,q=2\x1b\\')
})

test('splitPngStream splits concatenated PNG buffers accurately', () => {
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const pngIend = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
  const frame1 = Buffer.concat([pngSig, Buffer.from([1, 2, 3]), pngIend])
  const frame2 = Buffer.concat([pngSig, Buffer.from([4, 5, 6, 7]), pngIend])
  const partial = Buffer.concat([pngSig, Buffer.from([8, 9])])

  const frames = splitPngStream(Buffer.concat([frame1, frame2, partial]))
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[0], frame1)
  assert.deepEqual(frames[1], frame2)
})
