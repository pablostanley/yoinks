import React, {type ReactNode} from 'react'
import {Box, Text} from 'ink'
import {useTheme} from '../theme.js'

/** Total columns the button occupies (label + 2 cells padding per side). */
export const frameButtonWidth = (label: string) => label.length + 4

/**
 * A single-line input frame with the title sitting on the top border,
 * like `╭─ Paste a link ────╮`. Drawn by hand because ink borders
 * don't support embedded titles.
 *
 * `button` renders a filled block forged onto the right edge: the frame
 * drops its own right border and its lines run straight into the block, so
 * input and button read as one control. Half-blocks on the outer rows keep
 * the fill optically the same height as the thin frame borders. Clicks are
 * not handled here — the app hit-tests mouse events against the rendered
 * frame (see lib/click-map.ts). `buttonDim` shows the pressed/loading state.
 */
export function FramedInput({
  title,
  width,
  button,
  buttonDim = false,
  children,
}: {
  title: string
  width: number
  button?: string
  buttonDim?: boolean
  children: ReactNode
}) {
  const theme = useTheme()
  const inner = width - 2
  const tail = Math.max(0, inner - title.length - 3)
  const buttonW = button ? frameButtonWidth(button) : 0
  const fillColor = buttonDim ? theme.gray : theme.primary
  return (
    <Box width={width + buttonW}>
      <Box flexDirection="column" width={width}>
        <Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{'╭─ '}</Text>
          <Text color={theme.primary}>{title}</Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{` ${'─'.repeat(tail)}${button ? '─' : '╮'}`}</Text>
        </Text>
        <Box width={width} height={1} overflow="hidden">
          <Text color={theme.gray} dimColor={theme.dimSecondary}>│ </Text>
          <Text color={theme.primary}>❯ </Text>
          <Box flexGrow={1} height={1} overflow="hidden">
            {children}
          </Box>
          {button ? null : <Text color={theme.gray} dimColor={theme.dimSecondary}> │</Text>}
        </Box>
        <Text color={theme.gray} dimColor={theme.dimSecondary}>{`╰${'─'.repeat(inner)}${button ? '─' : '╯'}`}</Text>
      </Box>
      {button ? (
        <Box flexDirection="column" width={buttonW}>
          {/* bold matches the label row: with `inverse`, terminals brighten the
              bold default foreground, and the half-block fills must brighten too */}
          <Text bold color={fillColor} dimColor={buttonDim && theme.dimSecondary}>{'▄'.repeat(buttonW)}</Text>
          <Text
            backgroundColor={theme.inverseButton ? undefined : fillColor}
            color={theme.inverseButton ? undefined : theme.dark}
            // terminals disagree on whether `dim` reaches an inverted
            // background — many keep it bright, splitting the dim button into
            // gray/white/gray bands. Skip inverse while dim: the label fades
            // with the fills as a ghost button instead
            inverse={theme.inverseButton && !buttonDim}
            dimColor={buttonDim && theme.dimSecondary}
            bold
          >{`  ${button}  `}</Text>
          <Text bold color={fillColor} dimColor={buttonDim && theme.dimSecondary}>{'▀'.repeat(buttonW)}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
