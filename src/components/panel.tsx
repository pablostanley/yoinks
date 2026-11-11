import React, {type ReactNode} from 'react'
import {Box, Text} from 'ink'
import {useTheme} from '../theme.js'

/**
 * A bordered panel with the title on the top border, sized to its content:
 * the top line is drawn by hand (ink borders can't embed titles), the
 * sides and bottom come from ink with borderTop disabled.
 */
export function Panel({
  title,
  width,
  paddingX = 2,
  highlight = false,
  children,
}: {
  title: string
  width: number
  paddingX?: number
  highlight?: boolean
  children: ReactNode
}) {
  const theme = useTheme()
  const inner = width - 2
  const tail = Math.max(0, inner - title.length - 3)
  const borderColor = highlight ? theme.primary : theme.gray
  const borderDim = highlight ? false : theme.dimSecondary
  return (
    <Box flexDirection="column" width={width}>
      <Text>
        <Text color={borderColor} dimColor={borderDim}>{'╭─ '}</Text>
        <Text bold={highlight} color={theme.primary}>{title}</Text>
        <Text color={borderColor} dimColor={borderDim}>{` ${'─'.repeat(tail)}╮`}</Text>
      </Text>
      <Box
        width={width}
        borderStyle="round"
        borderColor={borderColor}
        borderDimColor={borderDim}
        borderBackgroundColor={theme.background}
        borderTop={false}
        flexDirection="column"
        paddingX={paddingX}
      >
        {children}
      </Box>
    </Box>
  )
}
