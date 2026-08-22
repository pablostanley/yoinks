import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {download} from './ytdlp.js'

/** A fake yt-dlp that writes real fragment files, announces them, then hangs.
 * `exec sleep` replaces the shell so SIGTERM kills the whole tree and the
 * stdio pipes close promptly (an orphaned child would delay 'close' for the
 * sleep's duration — which is exactly the production bug being tested). */
function writeFakeYtdlp(dir: string, destBase: string): string {
  const bin = path.join(dir, 'fake-ytdlp.sh')
  const part = path.join(dir, `${destBase}.part`)
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "[download] Destination: ${part}"
touch "${part}"
touch "${part}-Frag0"
touch "${part}-Frag1"
echo READY
exec sleep 30
`,
  )
  fs.chmodSync(bin, 0o755)
  return bin
}

async function cancelDownload(fakeBin: string, outDir: string): Promise<void> {
  const ac = new AbortController()
  const pending = download(
    {ytdlp: fakeBin, url: 'https://example.com/v', choice: {label: 'x', kind: 'video', args: []}, outDir},
    {onProgress: () => {}, onProcessing: () => {}},
    ac.signal,
  )
  // Wait until the fake has printed READY so its files definitely exist,
  // then a beat more so flowing-mode parsing has seen the Destination line.
  await new Promise(r => setTimeout(r, 700))
  ac.abort()
  await assert.rejects(pending, /abort|cancel/i)
  // The abort-time sweep is async; give it a beat.
  await new Promise(r => setTimeout(r, 300))
}

test('cancel sweeps the .part file and its range fragments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-frag-'))
  const base = 'video.f395.mp4'
  const bin = writeFakeYtdlp(dir, base)

  await cancelDownload(bin, dir)

  const leftovers = fs.readdirSync(dir).filter(f => f !== path.basename(bin))
  assert.deepEqual(leftovers, [], `expected no partials, found ${leftovers.join(', ')}`)
})

test('cancel still cleans up when Destination lines arrive late in the pipe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-late-'))
  const base = 'clip.f140.mp4'
  const bin = path.join(dir, 'late-ytdlp.sh')
  const part = path.join(dir, `${base}.part`)
  // Files first, announcement last — the pre-fix race lost this ordering.
  fs.writeFileSync(
    bin,
    `#!/bin/sh
touch "${part}"
touch "${part}-Frag0"
echo "[download] Destination: ${part}"
exec sleep 30
`,
  )
  fs.chmodSync(bin, 0o755)

  await cancelDownload(bin, dir)

  const leftovers = fs.readdirSync(dir).filter(f => f !== path.basename(bin))
  assert.deepEqual(leftovers, [], `expected no partials, found ${leftovers.join(', ')}`)
})
