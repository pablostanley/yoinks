/**
 * Split a command line into argv without invoking a shell. Quotes group
 * whitespace; backslashes escape whitespace, quotes, and backslashes, except
 * that a leading pair is preserved for Windows UNC paths such as \\server\share.
 */
export function parseYtdlpArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let tokenStarted = false

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!

    if (quote) {
      if (char === quote) {
        quote = undefined
        tokenStarted = true
      } else if (char === '\\' && quote === '"' && index + 1 < input.length) {
        const next = input[index + 1]!
        if (next === '"' || (next === '\\' && current.length > 0 && !current.endsWith('=')) || /\s/.test(next)) {
          current += next
          index++
        } else {
          current += char
        }
        tokenStarted = true
      } else {
        current += char
        tokenStarted = true
      }
      continue
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current)
        current = ''
        tokenStarted = false
      }
    } else if (char === '"' || char === "'") {
      quote = char
      tokenStarted = true
    } else if (char === '\\' && index + 1 < input.length) {
      const next = input[index + 1]!
      if (
        next === '"' ||
        next === "'" ||
        (next === '\\' && current.length > 0 && !current.endsWith('=')) ||
        /\s/.test(next)
      ) {
        current += next
        index++
      } else {
        current += char
      }
      tokenStarted = true
    } else {
      current += char
      tokenStarted = true
    }
  }

  if (quote) throw new Error(`Unclosed ${quote === '"' ? 'double' : 'single'} quote in yt-dlp arguments.`)
  if (tokenStarted) args.push(current)
  return args
}
