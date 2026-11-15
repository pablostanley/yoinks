import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {openFileCommand, revealFileCommands} from './open.js'

test('windows quotes the path itself, since explorer splits on commas', () => {
  const file = 'E:\\Downloads\\one, two & three.mp4'
  assert.deepEqual(openFileCommand(file, 'win32'), {
    command: 'explorer.exe',
    args: ['"E:\\Downloads\\one, two & three.mp4"'],
    verbatim: true,
    ignoreExit: true,
  })
  assert.deepEqual(revealFileCommands(file, 'win32'), [
    {
      command: 'explorer.exe',
      args: ['/select,"E:\\Downloads\\one, two & three.mp4"'],
      verbatim: true,
      ignoreExit: true,
    },
  ])
})

test('windows hands explorer a backslashed path', () => {
  assert.deepEqual(revealFileCommands('E:/Downloads/clip.mp4', 'win32')[0]!.args, ['/select,"E:\\Downloads\\clip.mp4"'])
})

test('macOS opens with open and reveals with open -R', () => {
  assert.deepEqual(openFileCommand('/Users/pablo/Downloads/clip.mp4', 'darwin'), {
    command: 'open',
    args: ['/Users/pablo/Downloads/clip.mp4'],
  })
  assert.deepEqual(revealFileCommands('/Users/pablo/Downloads/clip.mp4', 'darwin'), [
    {command: 'open', args: ['-R', '/Users/pablo/Downloads/clip.mp4']},
  ])
})

test('linux asks the file manager to select the file, then falls back to opening the folder', () => {
  // resolved so the fixture is absolute on whichever platform runs the tests
  const file = path.resolve('/home/pablo/Downloads/one, two.mp4')
  assert.deepEqual(openFileCommand(file, 'linux'), {command: 'xdg-open', args: [file]})

  const [select, fallback] = revealFileCommands(file, 'linux')
  assert.equal(select!.command, 'dbus-send')
  const uri = select!.args.find(arg => arg.startsWith('array:string:'))!.slice('array:string:'.length)
  assert.match(uri, /^file:\/\/.*one%2C%20two\.mp4$/)
  assert.ok(!uri.includes(','), 'a raw comma would split the dbus array')
  assert.deepEqual(fallback, {command: 'xdg-open', args: [path.dirname(file)]})
})
