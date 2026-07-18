import path from 'node:path'

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Return a user-facing error when a save-as value is not a plain filename. */
export function validateSaveAs(value: string): string | undefined {
  const name = value.trim()
  if (!name) return 'save-as name cannot be empty'
  if (name === '.' || name === '..') return 'save-as name must be a filename'
  if (INVALID_FILENAME_CHARS.test(name)) return 'save-as name cannot contain < > : " / \\ | ? *'
  if (/[. ]$/.test(name)) return 'save-as name cannot end with a dot or space'
  if (WINDOWS_RESERVED_NAME.test(name)) return `“${name}” is a reserved filename`
  return undefined
}

/** Build a safe yt-dlp output template, retaining the selected format's extension. */
export function saveAsOutputTemplate(
  outDir: string,
  saveAs: string | undefined,
): string {
  if (!saveAs) return path.join(outDir, '%(title).60s.%(ext)s')

  const error = validateSaveAs(saveAs)
  if (error) throw new Error(error)

  const trimmed = saveAs.trim()
  const stem = /\.(mp3|mp4)$/i.test(trimmed) ? trimmed.slice(0, -4) : trimmed

  // A literal percent must be doubled inside a yt-dlp output template.
  return path.join(outDir, `${stem.replaceAll('%', '%%')}.%(ext)s`)
}
