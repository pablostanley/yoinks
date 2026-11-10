import assert from 'node:assert/strict'
import test from 'node:test'
import {findPanelRectInLines, pointInRect} from './click-map.js'
import {parseSgrMouseEvents} from './use-mouse-click.js'
import {renderRgbFrameToLines} from './video-preview.js'

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

test('parseSgrMouseEvents parses clicks, hover moves, ignores wheel, and buffers split chunks', () => {
  const click = parseSgrMouseEvents('\x1b[<0;12;8M')
  assert.deepEqual(click.events, [
    {type: 'move', x: 12, y: 8},
    {type: 'click', x: 12, y: 8},
  ])
  assert.equal(click.pending, '')

  const hover = parseSgrMouseEvents('\x1b[<35;20;14M\x1b[<39;21;14M')
  assert.deepEqual(hover.events, [
    {type: 'move', x: 20, y: 14},
    {type: 'move', x: 21, y: 14},
  ])

  const wheel = parseSgrMouseEvents('\x1b[<64;20;14M\x1b[<65;20;14M')
  assert.deepEqual(wheel.events, [])

  const part1 = parseSgrMouseEvents('ignored\x1b[<35;18')
  assert.deepEqual(part1.events, [])
  assert.equal(part1.pending, '\x1b[<35;18')

  const part2 = parseSgrMouseEvents(';9M', part1.pending)
  assert.deepEqual(part2.events, [{type: 'move', x: 18, y: 9}])
  assert.equal(part2.pending, '')
})

test('findPanelRectInLines locates an Ink Panel containing truecolor half-block preview lines', async () => {
  const previousForceColor = process.env.FORCE_COLOR
  const previousNoColor = process.env.NO_COLOR
  process.env.FORCE_COLOR = '3'
  delete process.env.NO_COLOR

  try {
    const [{default: React}, {renderToString, Box, Text}, {Panel}, {ThemeProvider}] = await Promise.all([
      import('react'),
      import('ink'),
      import('../components/panel.js'),
      import('../theme.js'),
    ])

    const rgb = new Uint8Array(12 * 4 * 3).fill(120)
    const previewLines = renderRgbFrameToLines(rgb, 12, 4, {noColor: false})

    const output = renderToString(
      React.createElement(ThemeProvider, {
        mode: 'dark',
        children: React.createElement(
          Box,
          {paddingLeft: 4, paddingTop: 2},
          React.createElement(Panel, {
            title: 'Preview',
            width: 16,
            paddingX: 1,
            highlight: true,
            children: React.createElement(Box, {
              flexDirection: 'column',
              children: [
                ...previewLines.map((line, i) => React.createElement(Text, {key: i, children: line})),
                React.createElement(Text, {key: 'cap', children: '▶ hover'}),
              ],
            }),
          }),
        ),
      }),
    )

    const strippedLines = output.split('\n').map(stripAnsi)
    const rect = findPanelRectInLines(strippedLines, 'Preview')
    assert.deepEqual(rect, {left: 5, right: 20, top: 3, bottom: 7})

    assert.equal(pointInRect(5, 3, rect!), true)
    assert.equal(pointInRect(12, 5, rect!), true)
    assert.equal(pointInRect(20, 7, rect!), true)
    assert.equal(pointInRect(4, 5, rect!), false)
    assert.equal(pointInRect(21, 5, rect!), false)
    assert.equal(pointInRect(12, 2, rect!), false)
    assert.equal(pointInRect(12, 8, rect!), false)
  } finally {
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = previousForceColor
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
  }
})
