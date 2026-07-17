/**
 * User-facing preferences that apply to a whole download, independent of the
 * selected audio/video format. Keep this model free of yt-dlp arguments so
 * the TUI and CLI express intent rather than command-line implementation.
 */
export const DOWNLOAD_OPTION_DEFINITIONS = [
  {
    id: 'embedChapters',
    label: 'Embed chapters',
    cliFlag: '--embed-chapters',
  },
] as const

export type DownloadOptionId = (typeof DOWNLOAD_OPTION_DEFINITIONS)[number]['id']

export type DownloadOptions = Readonly<Record<DownloadOptionId, boolean>>

export const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = {
  embedChapters: false,
}

/** Resolve a supported CLI flag to the option it enables. */
export function downloadOptionForCliFlag(flag: string): DownloadOptionId | undefined {
  return DOWNLOAD_OPTION_DEFINITIONS.find(option => option.cliFlag === flag)?.id
}

/** Return a new preference object after changing one option. */
export function setDownloadOption(
  options: DownloadOptions,
  id: DownloadOptionId,
  enabled: boolean,
): DownloadOptions {
  return {...options, [id]: enabled}
}
