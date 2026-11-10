/**
 * Click hit-testing against the rendered frame. Ink has no absolute-position
 * API, so instead of re-deriving each widget's cell rectangle from layout
 * math (fragile — it broke whenever the layout changed), we keep a copy of
 * the last frame ink wrote and find clickable text in it by content.
 */

import {
  encodeKittyDelete,
  encodeKittyPngDisplay,
  encodeKittyRePlace,
} from './terminal-graphics.js'

// covers the CSI/OSC/APC sequences ink and graphics emit
const ANSI_PATTERN = new RegExp(
  [
    '\\u001B_[^\\u001B]*\\u001B\\\\',
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g',
)
const stripAnsi = (text: string) => text.replace(ANSI_PATTERN, '')

const PREVIEW_IMAGE_ID = 42
const PREVIEW_PLACEMENT_ID = 1

export type PreviewOverlay = {
  png: Buffer
  cols: number
  rows: number
  seq: number
}

// frame line i ↔ terminal row i+1: the app draws from the top of the
// alternate screen and rewrites the whole screen every frame
let frameLines: string[] = []
let rawStdout: NodeJS.WriteStream | undefined
let activeOverlay: PreviewOverlay | undefined
let uploadedSeq = -1
let overlayPlaced = false

function buildOverlaySequence(rect: PanelRect, overlay: PreviewOverlay): string {
  const col = rect.left + 2
  const row = rect.top + 1
  const innerCols = rect.right - rect.left - 3
  const innerRows = rect.bottom - rect.top - 2
  if (innerCols !== overlay.cols || innerRows !== overlay.rows) return ''

  const cmd =
    uploadedSeq === overlay.seq
      ? encodeKittyRePlace({id: PREVIEW_IMAGE_ID, placementId: PREVIEW_PLACEMENT_ID, cols: overlay.cols, rows: overlay.rows})
      : encodeKittyPngDisplay(overlay.png, {
          id: PREVIEW_IMAGE_ID,
          placementId: PREVIEW_PLACEMENT_ID,
          cols: overlay.cols,
          rows: overlay.rows,
        })
  uploadedSeq = overlay.seq
  overlayPlaced = true
  return `\x1b7\x1b[${row};${col}H${cmd}\x1b8`
}

/**
 * Register or clear the active Kitty graphics overlay rendered inside the
 * `Preview` panel. Writes directly to the unwrapped stdout stream so Ink's
 * frame capture isn't polluted.
 */
export function setPreviewOverlay(overlay: PreviewOverlay | undefined, fallbackStream?: NodeJS.WriteStream) {
  const stream = rawStdout ?? fallbackStream
  activeOverlay = overlay

  if (!overlay) {
    if (overlayPlaced && stream) {
      overlayPlaced = false
      uploadedSeq = -1
      stream.write(encodeKittyDelete(PREVIEW_IMAGE_ID))
    } else {
      overlayPlaced = false
      uploadedSeq = -1
    }
    return
  }

  if (!stream) return
  const rect = findPanelRectInLines(frameLines, 'Preview')
  if (!rect) return
  const seq = buildOverlaySequence(rect, overlay)
  if (seq) stream.write(`\x1b[?2026h${seq}\x1b[?2026l`)
}

/**
 * Wrap the stdout handed to ink's render() so every frame it writes is
 * kept for hit-testing. Cursor-only updates carry no printable text and
 * are ignored, so the last real frame stays around.
 */
export function captureFrames<T extends NodeJS.WriteStream>(stream: T): T {
  rawStdout = stream
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]) => {
          const text = String(chunk)
          const lines = text.split('\n').map(stripAnsi)
          let suffix = ''
          if (lines.some(line => line.trim() !== '')) {
            frameLines = lines
            if (activeOverlay) {
              const rect = findPanelRectInLines(frameLines, 'Preview')
              if (rect) {
                suffix = buildOverlaySequence(rect, activeOverlay)
              } else if (overlayPlaced) {
                overlayPlaced = false
                uploadedSeq = -1
                suffix = encodeKittyDelete(PREVIEW_IMAGE_ID)
              }
            } else if (overlayPlaced) {
              overlayPlaced = false
              uploadedSeq = -1
              suffix = encodeKittyDelete(PREVIEW_IMAGE_ID)
            }
          }
          const payload = suffix ? `${text}${suffix}` : chunk
          return (target.write as (...args: unknown[]) => boolean)(payload, ...rest)
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

export type ClickTarget = {
  /** exact text to find in the frame (colors are stripped before matching) */
  match: string
  action: () => void
  /** extra cells left/right of the match that still count as a hit */
  padX?: number
  /** extra rows above/below the match that still count as a hit (e.g. box borders) */
  padY?: number
}

/** First target whose text sits under the click. x/y are 1-based terminal cells. */
export function clickTargetAt(x: number, y: number, targets: ClickTarget[]): ClickTarget | undefined {
  for (const target of targets) {
    const {match, padX = 1, padY = 0} = target
    for (let row = y - 1 - padY; row <= y - 1 + padY; row++) {
      const line = frameLines[row]
      if (!line) continue
      let index = line.indexOf(match)
      while (index !== -1) {
        if (x - 1 >= index - padX && x - 1 <= index + match.length - 1 + padX) return target
        index = line.indexOf(match, index + 1)
      }
    }
  }
  return undefined
}

/** Frame line index of the first row containing `text`, or -1. */
export function findFrameRow(text: string): number {
  return frameLines.findIndex(line => line.includes(text))
}

/** 1-based [first, last] columns of the visible text on a frame row. */
export function frameRowSpan(row: number): [number, number] | undefined {
  const line = frameLines[row]
  if (!line) return undefined
  const first = line.search(/\S/)
  if (first === -1) return undefined
  return [first + 1, line.trimEnd().length]
}

export type PanelRect = {
  left: number
  right: number
  top: number
  bottom: number
}

/** Find a Panel's 1-based terminal cell bounds from stripped frame lines. */
export function findPanelRectInLines(lines: string[], title: string): PanelRect | undefined {
  const prefix = `╭─ ${title} `
  for (let topRow = 0; topRow < lines.length; topRow++) {
    const line = lines[topRow]!
    const leftIdx = line.indexOf(prefix)
    if (leftIdx === -1) continue
    const rightIdx = line.indexOf('╮', leftIdx + prefix.length)
    if (rightIdx === -1) continue
    for (let bottomRow = topRow + 1; bottomRow < lines.length; bottomRow++) {
      const bottomLine = lines[bottomRow]!
      if (bottomLine[leftIdx] === '╰' && bottomLine[rightIdx] === '╯') {
        return {
          left: leftIdx + 1,
          right: rightIdx + 1,
          top: topRow + 1,
          bottom: bottomRow + 1,
        }
      }
    }
  }
  return undefined
}

/** Find a Panel's 1-based terminal cell bounds in the most recently rendered frame. */
export function findPanelRect(title: string): PanelRect | undefined {
  return findPanelRectInLines(frameLines, title)
}

/** Check whether a 1-based (x, y) terminal cell falls inside `rect`. */
export function pointInRect(x: number, y: number, rect: PanelRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}
