export type GraphicsMode = 'kitty' | 'halfblock'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
const KITTY_CHUNK_SIZE = 4096

/**
 * Probe whether the connected TTY supports the Kitty Graphics Protocol.
 * Sends a 1x1 quiet graphics query followed by Primary Device Attributes
 * (`CSI c`) as recommended by the Kitty spec: any non-Kitty terminal answers
 * `CSI c` immediately without answering the graphics query, so detection
 * finishes in ~5-20ms on real terminals.
 */
export async function detectTerminalGraphics(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  timeoutMs = 120,
): Promise<GraphicsMode> {
  if (process.env.NO_COLOR || !stdin.isTTY || !stdout.isTTY) return 'halfblock'

  const envFallback: GraphicsMode =
    process.env.KITTY_WINDOW_ID ||
    process.env.TERM === 'xterm-kitty' ||
    process.env.GHOSTTY_RESOURCES_DIR ||
    process.env.TERM_PROGRAM === 'ghostty'
      ? 'kitty'
      : 'halfblock'

  return new Promise(resolve => {
    const wasRaw = Boolean(stdin.isRaw)
    let buffer = ''
    let settled = false

    const finish = (mode: GraphicsMode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.off('data', onData)
      try {
        if (!wasRaw && stdin.isTTY) {
          stdin.setRawMode(false)
          stdin.pause()
        }
      } catch {
        // ignore raw mode restore errors on closed tty
      }
      resolve(mode)
    }

    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk)
      if (/\x1b_Gi=31;OK\x1b\\/.test(buffer)) {
        // Wait briefly for the trailing DA1 response so it doesn't leak into Ink
        if (/\x1b\[\??[\d;]*c/.test(buffer)) finish('kitty')
        return
      }
      if (/\x1b\[\??[\d;]*c/.test(buffer)) {
        finish(/\x1b_Gi=31;OK/.test(buffer) ? 'kitty' : 'halfblock')
      }
    }

    const timer = setTimeout(() => {
      finish(/\x1b_Gi=31;OK/.test(buffer) ? 'kitty' : envFallback)
    }, timeoutMs)

    try {
      if (!wasRaw) stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onData)
      stdout.write('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c')
    } catch {
      finish(envFallback)
    }
  })
}

/**
 * Encode a PNG buffer as chunked Kitty Graphics Protocol APC commands that
 * transmit and display in-place without moving the cursor (`C=1`) or emitting
 * responses (`q=2`).
 */
export function encodeKittyPngDisplay(
  png: Buffer,
  opts: {id: number; placementId: number; cols: number; rows: number},
): string {
  const b64 = png.toString('base64')
  const header = `a=T,f=100,i=${opts.id},p=${opts.placementId},c=${opts.cols},r=${opts.rows},C=1,q=2`

  if (b64.length <= KITTY_CHUNK_SIZE) {
    return `\x1b_G${header};${b64}\x1b\\`
  }

  let out = ''
  for (let offset = 0; offset < b64.length; offset += KITTY_CHUNK_SIZE) {
    const chunk = b64.slice(offset, offset + KITTY_CHUNK_SIZE)
    const isFirst = offset === 0
    const isLast = offset + KITTY_CHUNK_SIZE >= b64.length
    const more = isLast ? 0 : 1
    if (isFirst) {
      out += `\x1b_G${header},m=${more};${chunk}\x1b\\`
    } else {
      out += `\x1b_Gm=${more};${chunk}\x1b\\`
    }
  }
  return out
}

/** Re-place an already-uploaded Kitty image in-place without re-sending bytes. */
export function encodeKittyRePlace(opts: {id: number; placementId: number; cols: number; rows: number}): string {
  return `\x1b_Ga=p,i=${opts.id},p=${opts.placementId},c=${opts.cols},r=${opts.rows},C=1,q=2\x1b\\`
}

/** Delete visible Kitty image placements (and free stored data). */
export function encodeKittyDelete(id?: number): string {
  if (typeof id === 'number') {
    return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`
  }
  return '\x1b_Ga=d,d=A,q=2\x1b\\'
}

/** Split an `ffmpeg -f image2pipe -vcodec png` byte stream into complete PNG buffers. */
export function splitPngStream(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = []
  let pos = buffer.indexOf(PNG_SIGNATURE)
  while (pos !== -1) {
    const next = buffer.indexOf(PNG_SIGNATURE, pos + PNG_SIGNATURE.length)
    const slice = next === -1 ? buffer.subarray(pos) : buffer.subarray(pos, next)
    if (slice.includes(PNG_IEND)) {
      frames.push(Buffer.from(slice))
    }
    pos = next
  }
  return frames
}
