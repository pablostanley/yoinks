import fs from 'node:fs/promises'
import React, {useCallback, useEffect, useRef, useState} from 'react'
import {Box, Text, useStdout} from 'ink'
import Spinner from 'ink-spinner'
import {setPreviewOverlay} from '../lib/click-map.js'
import {formatDuration, truncate} from '../lib/format.js'
import type {GraphicsMode} from '../lib/terminal-graphics.js'
import {
  downloadLocalPreviewFile,
  fetchThumbnailGraphic,
  fetchVideoClip,
  hasVideoContent,
  pickPreviewStreams,
  pickRandomClipTimestamp,
  type PreviewFrame,
  type PreviewStream,
  type ThumbnailGraphic,
  type VideoClip,
} from '../lib/video-preview.js'
import {resolveFfmpegExecutable, type VideoInfo} from '../lib/ytdlp.js'
import {useTheme, type Theme} from '../theme.js'
import {Panel} from './panel.js'

const CLIP_DURATION_SEC = 2.5
const CLIP_FPS = 10
const MAX_CACHED_CLIPS = 6

let nextGraphicSeq = 1

type VideoPreviewProps = {
  info: VideoInfo
  videoUrl?: string
  infoJsonPath?: string
  ytdlpPath?: string
  width: number
  imageRows: number
  isHovered: boolean
  skipClipTrigger?: number
  graphicsMode?: GraphicsMode
}

function renderScrubber(currentSec: number, duration: number, width: number, theme: Theme) {
  const left = `▶ ${formatDuration(Math.min(duration, Math.max(0, currentSec))) || '0:00'}`
  const right = formatDuration(duration) || '0:00'
  const barWidth = width - left.length - right.length - 2
  if (barWidth < 4) {
    return (
      <Text color={theme.primary} bold>
        {truncate(`${left} / ${right}`, width)}
      </Text>
    )
  }
  const ratio = Math.max(0, Math.min(1, currentSec / duration))
  const dotIdx = Math.round(ratio * (barWidth - 1))
  const before = '─'.repeat(dotIdx)
  const after = '─'.repeat(Math.max(0, barWidth - 1 - dotIdx))
  return (
    <Text>
      <Text color={theme.primary}>{left}</Text>
      <Text color={theme.gray} dimColor={theme.dimSecondary}>{` ${before}`}</Text>
      <Text color={theme.primary}>●</Text>
      <Text color={theme.gray} dimColor={theme.dimSecondary}>{`${after} ${right}`}</Text>
    </Text>
  )
}

function clipLength(clip: VideoClip | undefined, mode: GraphicsMode): number {
  if (!clip) return 0
  return mode === 'kitty' ? (clip.pngFrames?.length ?? 0) : clip.frames.length
}

function firstClipThumbnail(clip: VideoClip, mode: GraphicsMode): ThumbnailGraphic | undefined {
  if (mode === 'kitty') {
    const png = clip.pngFrames?.[0]
    return png ? {png} : undefined
  }
  const lines = clip.frames[0]
  return lines ? {lines} : undefined
}

export function VideoPreview({
  info,
  videoUrl,
  infoJsonPath,
  ytdlpPath,
  width,
  imageRows,
  isHovered,
  skipClipTrigger = 0,
  graphicsMode = 'halfblock',
}: VideoPreviewProps) {
  const theme = useTheme()
  const {stdout} = useStdout()
  const imageCols = Math.max(8, width - 4)
  const videoExists = hasVideoContent(info)

  const [thumbnail, setThumbnail] = useState<ThumbnailGraphic>()
  const [thumbnailDone, setThumbnailDone] = useState(false)
  const [clips, setClips] = useState<VideoClip[]>([])
  const [activeClipIndex, setActiveClipIndex] = useState(0)
  const [frameIndex, setFrameIndex] = useState(0)
  const [manualPlay, setManualPlay] = useState(false)
  const [ffmpegMissing, setFfmpegMissing] = useState(false)
  const [clipsUnavailable, setClipsUnavailable] = useState(false)

  const ffmpegRef = useRef<string | undefined>(undefined)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const workingStreamRef = useRef<PreviewStream | undefined>(undefined)
  const localPreviewDirRef = useRef<string | undefined>(undefined)
  const localPreviewFileRef = useRef<string | undefined>(undefined)
  const localFallbackTriedRef = useRef(false)
  const thumbnailRef = useRef<ThumbnailGraphic | undefined>(undefined)
  const clipsRef = useRef<VideoClip[]>([])
  const activeClipIndexRef = useRef(0)
  const frameIndexRef = useRef(0)
  const recentStartsRef = useRef<number[]>([])
  const fetchingClipRef = useRef(false)
  const failuresRef = useRef(0)
  const prevHoverRef = useRef(isHovered)
  const prevSkipRef = useRef(skipClipTrigger)

  thumbnailRef.current = thumbnail
  clipsRef.current = clips
  activeClipIndexRef.current = activeClipIndex
  frameIndexRef.current = frameIndex
  const isPlaying = isHovered || manualPlay

  const loadAnotherClip = useCallback(
    async (forceReplace = false) => {
      const ffmpegPath = ffmpegRef.current
      const signal = abortRef.current?.signal
      if (!ffmpegPath || !signal || signal.aborted) return
      if (!videoExists || fetchingClipRef.current) return
      if (failuresRef.current >= 3 && clipsRef.current.length === 0) return

      const candidateStreams = pickPreviewStreams(info)
      const orderedStreams = workingStreamRef.current
        ? [workingStreamRef.current, ...candidateStreams.filter(s => s.formatId !== workingStreamRef.current!.formatId)]
        : candidateStreams

      const hasYtDlpSource = Boolean(ytdlpPath && (infoJsonPath || videoUrl || info.webpage_url))
      if (orderedStreams.length === 0 && !localPreviewFileRef.current && !hasYtDlpSource) {
        setClipsUnavailable(true)
        return
      }

      fetchingClipRef.current = true
      try {
        const startSec = pickRandomClipTimestamp(info.duration, CLIP_DURATION_SEC, recentStartsRef.current)
        recentStartsRef.current.push(startSec)
        if (recentStartsRef.current.length > 12) recentStartsRef.current.shift()

        const resolvedUrl = videoUrl ?? info.webpage_url
        const isShortVideo = typeof info.duration === 'number' && info.duration > 0 && info.duration <= 90

        // For short videos, skip slow per-clip yt-dlp sections when direct streaming
        // fails and cache a single compact local copy for instant multi-clip seeking.
        let clip = await fetchVideoClip({
          ffmpegPath,
          ytdlpPath: isShortVideo ? undefined : ytdlpPath,
          infoJsonPath,
          videoUrl: resolvedUrl,
          localFilePath: localPreviewFileRef.current,
          streams: orderedStreams,
          startSec,
          clipDurationSec: CLIP_DURATION_SEC,
          fps: CLIP_FPS,
          dims: {cols: imageCols, rows: imageRows},
          mode: graphicsMode,
          signal,
        })

        if (
          (!clip || clipLength(clip, graphicsMode) === 0) &&
          !localPreviewFileRef.current &&
          !localFallbackTriedRef.current &&
          hasYtDlpSource &&
          !signal.aborted
        ) {
          localFallbackTriedRef.current = true
          const local = await downloadLocalPreviewFile({
            ytdlpPath: ytdlpPath!,
            ffmpegPath,
            infoJsonPath,
            videoUrl: resolvedUrl,
            signal,
          })
          if (local && !signal.aborted) {
            localPreviewDirRef.current = local.dir
            localPreviewFileRef.current = local.filePath
            clip = await fetchVideoClip({
              ffmpegPath,
              localFilePath: local.filePath,
              startSec,
              clipDurationSec: CLIP_DURATION_SEC,
              fps: CLIP_FPS,
              dims: {cols: imageCols, rows: imageRows},
              mode: graphicsMode,
              signal,
            })
          } else if (isShortVideo && !signal.aborted) {
            clip = await fetchVideoClip({
              ffmpegPath,
              ytdlpPath,
              infoJsonPath,
              videoUrl: resolvedUrl,
              streams: [],
              startSec,
              clipDurationSec: CLIP_DURATION_SEC,
              fps: CLIP_FPS,
              dims: {cols: imageCols, rows: imageRows},
              mode: graphicsMode,
              signal,
            })
          }
        }

        if (signal.aborted) return
        if (clip && clipLength(clip, graphicsMode) > 0) {
          failuresRef.current = 0
          if (clip.stream) workingStreamRef.current = clip.stream
          if (!thumbnailRef.current) {
            const fallbackThumb = firstClipThumbnail(clip, graphicsMode)
            if (fallbackThumb) setThumbnail(fallbackThumb)
          }
          setClips(prev => {
            if (prev.length >= MAX_CACHED_CLIPS) {
              if (!forceReplace) return prev
              return [...prev.slice(1), clip!]
            }
            return [...prev, clip!]
          })
        } else {
          failuresRef.current += 1
          if (failuresRef.current >= 3 && clipsRef.current.length === 0) {
            setClipsUnavailable(true)
          }
        }
      } finally {
        fetchingClipRef.current = false
      }
    },
    [graphicsMode, imageCols, imageRows, info, infoJsonPath, videoExists, videoUrl, ytdlpPath],
  )

  // Load thumbnail and prefetch the first random clip whenever video or preview size changes
  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    workingStreamRef.current = undefined
    localPreviewFileRef.current = undefined
    localFallbackTriedRef.current = false
    clipsRef.current = []
    activeClipIndexRef.current = 0
    frameIndexRef.current = 0
    recentStartsRef.current = []
    fetchingClipRef.current = false
    failuresRef.current = 0

    setThumbnail(undefined)
    setThumbnailDone(false)
    setClips([])
    setActiveClipIndex(0)
    setFrameIndex(0)
    setFfmpegMissing(false)
    setClipsUnavailable(false)

    void (async () => {
      const ffmpegPath = await resolveFfmpegExecutable()
      if (controller.signal.aborted) return
      if (!ffmpegPath) {
        ffmpegRef.current = undefined
        setFfmpegMissing(true)
        setThumbnailDone(true)
        return
      }
      ffmpegRef.current = ffmpegPath

      const thumb = await fetchThumbnailGraphic({
        ffmpegPath,
        info,
        dims: {cols: imageCols, rows: imageRows},
        mode: graphicsMode,
        ytdlpPath,
        infoJsonPath,
        videoUrl: videoUrl ?? info.webpage_url,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setThumbnail(thumb)
      setThumbnailDone(true)

      if (videoExists) {
        void loadAnotherClip(false)
      }
    })()

    return () => {
      controller.abort()
      const dir = localPreviewDirRef.current
      localPreviewDirRef.current = undefined
      localPreviewFileRef.current = undefined
      if (dir) void fs.rm(dir, {recursive: true, force: true}).catch(() => {})
    }
  }, [graphicsMode, imageCols, imageRows, info, infoJsonPath, loadAnotherClip, videoExists, videoUrl, ytdlpPath])

  // Clear manual playback when mouse leaves, and rotate clip when hovering back in
  useEffect(() => {
    if (prevHoverRef.current && !isHovered) {
      setManualPlay(false)
      frameIndexRef.current = 0
      setFrameIndex(0)
    } else if (!prevHoverRef.current && isHovered && clipsRef.current.length > 1) {
      const next = (activeClipIndexRef.current + 1) % clipsRef.current.length
      activeClipIndexRef.current = next
      frameIndexRef.current = 0
      setActiveClipIndex(next)
      setFrameIndex(0)
    }
    prevHoverRef.current = isHovered
  }, [isHovered])

  // Clicking the preview skips to another random clip (or toggles playback if not hovered)
  useEffect(() => {
    if (skipClipTrigger === prevSkipRef.current) return
    prevSkipRef.current = skipClipTrigger

    if (!isHovered) {
      setManualPlay(prev => !prev)
    } else if (clipsRef.current.length > 1) {
      const next = (activeClipIndexRef.current + 1) % clipsRef.current.length
      activeClipIndexRef.current = next
      frameIndexRef.current = 0
      setActiveClipIndex(next)
      setFrameIndex(0)
      void loadAnotherClip(true)
    } else {
      void loadAnotherClip(true)
    }
  }, [isHovered, loadAnotherClip, skipClipTrigger])

  // Ensure clips keep loading while playing
  useEffect(() => {
    if (!isPlaying || !videoExists || clipsUnavailable || ffmpegMissing) return
    if (clips.length === 0 || (clips.length < MAX_CACHED_CLIPS && activeClipIndex >= clips.length - 1)) {
      void loadAnotherClip(false)
    }
  }, [activeClipIndex, clips.length, clipsUnavailable, ffmpegMissing, isPlaying, loadAnotherClip, videoExists])

  // Advance frames at the clip's fps while hovered / playing
  const activeClip = clips.length > 0 ? clips[activeClipIndex % clips.length] : undefined
  const activeFrameCount = clipLength(activeClip, graphicsMode)

  useEffect(() => {
    if (!isPlaying || !activeClip || activeFrameCount === 0) return

    const intervalMs = Math.max(40, Math.round(1000 / activeClip.fps))
    const id = setInterval(() => {
      const nextFrame = frameIndexRef.current + 1
      if (nextFrame < activeFrameCount) {
        frameIndexRef.current = nextFrame
        setFrameIndex(nextFrame)
        return
      }
      frameIndexRef.current = 0
      setFrameIndex(0)
      const total = clipsRef.current.length
      if (total <= 1) {
        void loadAnotherClip(false)
        return
      }
      const nextClip = (activeClipIndexRef.current + 1) % total
      activeClipIndexRef.current = nextClip
      setActiveClipIndex(nextClip)
      if (nextClip === 0 || total < MAX_CACHED_CLIPS) {
        void loadAnotherClip(total >= MAX_CACHED_CLIPS)
      }
    }, intervalMs)

    return () => clearInterval(id)
  }, [activeClip, activeFrameCount, isPlaying, loadAnotherClip])

  const shownPng: Buffer | undefined =
    graphicsMode === 'kitty'
      ? isPlaying && activeClip?.pngFrames && activeClip.pngFrames.length > 0
        ? activeClip.pngFrames[frameIndex % activeClip.pngFrames.length]
        : thumbnail?.png
      : undefined

  const shownLines: PreviewFrame | undefined =
    graphicsMode === 'halfblock'
      ? isPlaying && activeClip && activeClip.frames.length > 0
        ? activeClip.frames[frameIndex % activeClip.frames.length]
        : thumbnail?.lines
      : undefined

  // Push Kitty PNG overlay whenever frame, mode, or dimensions change
  useEffect(() => {
    if (graphicsMode !== 'kitty' || !shownPng) {
      setPreviewOverlay(undefined, stdout)
      return
    }
    setPreviewOverlay({png: shownPng, cols: imageCols, rows: imageRows, seq: nextGraphicSeq++}, stdout)
  }, [graphicsMode, imageCols, imageRows, shownPng, stdout])

  // Clean up Kitty overlay on unmount
  useEffect(() => {
    return () => {
      setPreviewOverlay(undefined, stdout)
    }
  }, [stdout])

  const hasReadyGraphic = Boolean(shownPng || shownLines)
  const stillFetchingFallbackThumb = !thumbnail && videoExists && !clipsUnavailable && !ffmpegMissing && clips.length === 0

  return (
    <Panel title="Preview" width={width} paddingX={1} highlight={isPlaying}>
      <Box flexDirection="column" height={imageRows} width={imageCols} justifyContent="center" alignItems="center">
        {shownPng ? (
          Array.from({length: imageRows}, (_, idx) => <Text key={idx}>{' '.repeat(imageCols)}</Text>)
        ) : shownLines ? (
          shownLines.map((row, idx) => <Text key={idx}>{row}</Text>)
        ) : !thumbnailDone || stillFetchingFallbackThumb ? (
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            <Text color={theme.primary}>
              <Spinner type="dots" />
            </Text>
            {' loading preview…'}
          </Text>
        ) : !hasReadyGraphic ? (
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {ffmpegMissing ? 'ffmpeg unavailable' : 'no preview available'}
          </Text>
        ) : null}
      </Box>

      <Box height={1} width={imageCols}>
        {isPlaying && activeClip ? (
          info.duration && info.duration > 0 ? (
            renderScrubber(activeClip.startSec + frameIndex / activeClip.fps, info.duration, imageCols, theme)
          ) : (
            <Text color={theme.primary}>{truncate(`▶ random clip #${(activeClipIndex % clips.length) + 1}`, imageCols)}</Text>
          )
        ) : isPlaying ? (
          clipsUnavailable ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>{truncate('clips unavailable', imageCols)}</Text>
          ) : !videoExists ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>{truncate('♪ audio only', imageCols)}</Text>
          ) : ffmpegMissing ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>{truncate('ffmpeg needed for clips', imageCols)}</Text>
          ) : (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>
              <Text color={theme.primary}>
                <Spinner type="dots" />
              </Text>
              {truncate(' loading random clip…', imageCols - 1)}
            </Text>
          )
        ) : ffmpegMissing ? (
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{truncate('ffmpeg needed for preview', imageCols)}</Text>
        ) : !videoExists ? (
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{truncate('♪ audio only', imageCols)}</Text>
        ) : clipsUnavailable ? (
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{truncate('thumbnail preview', imageCols)}</Text>
        ) : (
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{truncate('▶ hover for random clips', imageCols)}</Text>
        )}
      </Box>
    </Panel>
  )
}
