import assert from 'node:assert/strict'
import test from 'node:test'
import {parseYtdlpArgs} from './ytdlp-args.js'

test('parses browser cookies and JavaScript runtime options', () => {
  assert.deepEqual(parseYtdlpArgs('--cookies-from-browser firefox --js-runtimes node'), [
    '--cookies-from-browser',
    'firefox',
    '--js-runtimes',
    'node',
  ])
})

test('handles empty input, equals options, and empty quoted values', () => {
  assert.deepEqual(parseYtdlpArgs('  \t\n '), [])
  assert.deepEqual(parseYtdlpArgs('--js-runtimes=node --proxy ""'), [
    '--js-runtimes=node',
    '--proxy',
    '',
  ])
})

test('preserves quoted paths and ordinary Windows backslashes', () => {
  assert.deepEqual(parseYtdlpArgs('--cookies-from-browser "chrome:C:\\Users\\Test User" --path C:\\Temp'), [
    '--cookies-from-browser',
    'chrome:C:\\Users\\Test User',
    '--path',
    'C:\\Temp',
  ])
})

test('preserves UNC path prefixes inside and outside quotes', () => {
  assert.deepEqual(parseYtdlpArgs('--paths \\\\server\\share\\media --quoted "\\\\server\\shared folder"'), [
    '--paths',
    '\\\\server\\share\\media',
    '--quoted',
    '\\\\server\\shared folder',
  ])
})

test('supports escaped trailing backslashes in quoted Windows paths', () => {
  assert.deepEqual(parseYtdlpArgs('--root "C:\\\\"'), ['--root', 'C:\\'])
})

test('preserves UNC prefixes in equals-form options', () => {
  assert.deepEqual(parseYtdlpArgs('--paths=\\\\server\\share --quoted="\\\\server\\shared folder"'), [
    '--paths=\\\\server\\share',
    '--quoted=\\\\server\\shared folder',
  ])
})

test('supports single quotes, escaped whitespace, and adjacent quoted fragments', () => {
  assert.deepEqual(parseYtdlpArgs("--name 'two words' three\\ words pre\"fix\"suffix"), [
    '--name',
    'two words',
    'three words',
    'prefixsuffix',
  ])
})

test('treats shell operators as ordinary argument text', () => {
  assert.deepEqual(parseYtdlpArgs('--exec "echo $HOME; printf | cat"'), [
    '--exec',
    'echo $HOME; printf | cat',
  ])
})

test('rejects unclosed quotes', () => {
  assert.throws(() => parseYtdlpArgs('--proxy "http://localhost:8080'), /Unclosed double quote/)
  assert.throws(() => parseYtdlpArgs("--proxy 'http://localhost:8080"), /Unclosed single quote/)
})
