import {useEffect, useRef} from 'react'
import {useStdin, useStdout} from 'ink'

// 1000h = report button presses, 1003h = report all motion (hover), 1006h = SGR encoding (`ESC [ < b ; x ; y M`)
const ENABLE_CLICKS = '\u001B[?1000h\u001B[?1006h'
const DISABLE_CLICKS = '\u001B[?1006l\u001B[?1000l'
const ENABLE_HOVER = '\u001B[?1003h'
const DISABLE_HOVER = '\u001B[?1003l'
const SGR_EVENT = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g
const INCOMPLETE_SGR_TAIL = /\u001B(?:\[(?:<[\d;]*)?)?$/

export type MouseEvent = {
  type: 'click' | 'move'
  x: number
  y: number
}

/**
 * Parse SGR mouse reports from a stdin chunk, preserving any trailing incomplete
 * SGR sequence so multi-chunk reports aren't dropped.
 */
export function parseSgrMouseEvents(
  chunk: string,
  pending = '',
): {events: MouseEvent[]; pending: string} {
  const text = pending + chunk
  const events: MouseEvent[] = []
  let lastMatchedEnd = 0

  SGR_EVENT.lastIndex = 0
  for (const match of text.matchAll(SGR_EVENT)) {
    const button = Number(match[1])
    const x = Number(match[2])
    const y = Number(match[3])
    const kind = match[4]
    lastMatchedEnd = (match.index ?? 0) + match[0].length

    // ignore scroll wheel events (bit 64)
    if ((button & 64) !== 0) continue

    const isMotion = (button & 32) !== 0
    events.push({type: 'move', x, y})
    if (kind === 'M' && !isMotion && (button & 3) === 0) {
      events.push({type: 'click', x, y})
    }
  }

  const tail = text.slice(lastMatchedEnd)
  const incomplete = INCOMPLETE_SGR_TAIL.exec(tail)?.[0]
  return {
    events,
    pending: incomplete && incomplete.length <= 32 ? incomplete : '',
  }
}

export type MouseOptions = {
  onMove?: (x: number, y: number) => void
  trackHover?: boolean
}

/**
 * Reports left-button presses (and optionally hover motion) as 1-based
 * (column, row) terminal cells. While active the terminal's native text
 * selection needs a modifier key (option/shift) — the tradeoff for receiving
 * mouse events at all.
 */
export function useMouseClick(
  onClick: (x: number, y: number) => void,
  isActive: boolean,
  options: MouseOptions = {},
) {
  const clickRef = useRef(onClick)
  clickRef.current = onClick
  const moveRef = useRef(options.onMove)
  moveRef.current = options.onMove
  const trackHover = Boolean(options.trackHover)
  const {stdin} = useStdin()
  const {stdout} = useStdout()

  useEffect(() => {
    if (!isActive || !stdin || !stdout || !process.stdin.isTTY) return
    stdout.write(ENABLE_CLICKS)
    let pending = ''
    const onData = (data: Buffer | string) => {
      const parsed = parseSgrMouseEvents(String(data), pending)
      pending = parsed.pending
      for (const event of parsed.events) {
        if (event.type === 'click') clickRef.current(event.x, event.y)
        else moveRef.current?.(event.x, event.y)
      }
    }
    stdin.on('data', onData)
    return () => {
      stdin.off('data', onData)
      stdout.write(DISABLE_CLICKS)
    }
  }, [isActive, stdin, stdout])

  useEffect(() => {
    if (!isActive || !trackHover || !stdout || !process.stdin.isTTY) return
    stdout.write(ENABLE_HOVER)
    return () => {
      stdout.write(DISABLE_HOVER)
    }
  }, [isActive, trackHover, stdout])
}

/**
 * Mouse reports also flow through ink's keypress parsing, which strips the
 * leading ESC and hands the rest (`[<0;34;12M`) to ink-text-input as typed
 * text. Run every onChange value through this to drop the leaked reports.
 */
export const stripMouseReports = (value: string) =>
  value.replace(/\u001B?\[?<\d+;\d+;\d+[Mm]/g, '')
