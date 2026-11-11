import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {download, resolveOutDir} from './ytdlp.js'

test('resolveOutDir defaults to current working directory and resolves relative paths', () => {
  assert.equal(resolveOutDir(), path.resolve(process.cwd()))
  assert.equal(resolveOutDir('./videos'), path.resolve('./videos'))
})

test('download saves files into the specified outDir', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-outdir-test-'))
  const saveDir = path.join(tmpDir, 'terminal-location')
  await fs.mkdir(saveDir, {recursive: true})

  const mockYtDlp = path.join(tmpDir, 'mock-ytdlp.mjs')
  await fs.writeFile(
    mockYtDlp,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const template = outIdx !== -1 ? args[outIdx + 1] : '';
const fs = await import('node:fs');
const path = await import('node:path');
const outFile = template.replace('%(title).60s.%(ext)s', 'sample-video.mp4');
fs.writeFileSync(outFile, 'ok');
console.log(outFile);
`,
  )
  await fs.chmod(mockYtDlp, 0o755)

  try {
    const saved = await download(
      {
        ytdlp: mockYtDlp,
        url: 'https://example.com/video',
        choice: {kind: 'video', label: '720p · mp4', args: ['-f', 'best']},
        outDir: resolveOutDir(saveDir),
      },
      {onProgress: () => {}, onProcessing: () => {}},
    )
    assert.equal(saved, path.join(saveDir, 'sample-video.mp4'))
    assert.equal(await fs.readFile(saved, 'utf8'), 'ok')
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true})
  }
})
