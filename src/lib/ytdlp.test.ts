import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {download} from './ytdlp.js'

test('forces UTF-8 yt-dlp output so non-ASCII filepaths survive', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'yoinks-encoding-'))
  const title = 'Жизнь после выхода'
  const filepath = path.join(dir, `${title}.mp4`)
  const fixture = path.join(dir, 'fake-ytdlp.cjs')
  await writeFile(
    fixture,
    [
      'const path = require("node:path")',
      `const title = ${JSON.stringify(title)}`,
      'const filepath = path.join(__dirname, title + ".mp4")',
      'const forced = process.argv[process.argv.indexOf("--encoding") + 1] === "utf-8"',
      'const output = forced ? filepath : Buffer.from(filepath, "utf8").toString("latin1")',
      'process.stdout.write(output + "\\n")',
    ].join('\n'),
  )

  try {
    const result = await download(
      {
        ytdlp: process.execPath,
        extraArgs: [fixture],
        url: 'https://example.com/video',
        choice: {label: 'best available', kind: 'video', args: []},
        outDir: dir,
      },
      {onProgress: () => {}, onProcessing: () => {}},
    )
    assert.equal(result, filepath)
  } finally {
    await rm(dir, {force: true, recursive: true})
  }
})
