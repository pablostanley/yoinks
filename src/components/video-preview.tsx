import React, {useCallback, useEffect, useRef, useState} from 'react'
import {Box, Text, useStdout} from 'ink'
import Spinner from 'ink-spinner'
import {setPreviewOverlay} from '../lib/click-map.js'
import {formatDuration, truncate} from '../lib/format.js'
import type {GraphicsMode} from '../lib/terminal-graphics.js'
import {
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

export function VideoPreview({
  info,
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
  const clipsRef = useRef<VideoClip[]>([])
  const activeClipIndexRef = useRef(0)
  const frameIndexRef = useRef(0)
  const recentStartsRef = useRef<number[]>([])
  const fetchingClipRef = useRef(false)
  const failuresRef = useRef(0)
  const prevHoverRef = useRef(isHovered)
  const prevSkipRef = useRef(skipClipTrigger)

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
      if (failuresRef.current >= 2 && clipsRef.current.length === 0) return

      const candidateStreams = pickPreviewStreams(info)
      const orderedStreams = workingStreamRef.current
        ? [workingStreamRef.current, ...candidateStreams.filter(s => s.formatId !== workingStreamRef.current!.formatId)]
        : candidateStreams

      if (orderedStreams.length === 0 && !(ytdlpPath && infoJsonPath)) {
        setClipsUnavailable(true)
        return
      }

      fetchingClipRef.current = true
      try {
        const startSec = pickRandomClipTimestamp(info.duration, CLIP_DURATION_SEC, recentStartsRef.current)
        recentStartsRef.current.push(startSec)
        if (recentStartsRef.current.length > 12) recentStartsRef.current.shift()

        const clip = await fetchVideoClip({
          ffmpegPath,
          ytdlpPath,
          infoJsonPath,
          streams: orderedStreams,
          startSec,
          clipDurationSec: CLIP_DURATION_SEC,
          fps: CLIP_FPS,
          dims: {cols: imageCols, rows: imageRows},
          mode: graphicsMode,
          signal,
        })

        if (signal.aborted) return
        if (clip && clipLength(clip, graphicsMode) > 0) {
          failuresRef.current = 0
          if (clip.stream) workingStreamRef.current = clip.stream
          setClips(prev => {
            if (prev.length >= MAX_CACHED_CLIPS) {
              if (!forceReplace) return prev
              return [...prev.slice(1), clip]
            }
            return [...prev, clip]
          })
        } else {
          failuresRef.current += 1
          if (failuresRef.current >= 2 && clipsRef.current.length === 0) {
            setClipsUnavailable(true)
          }
        }
      } finally {
        fetchingClipRef.current = false
      }
    },
    [graphicsMode, imageCols, imageRows, info, infoJsonPath, videoExists, ytdlpPath],
  )

  // Load thumbnail and prefetch the first random clip whenever video or preview size changes
  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    workingStreamRef.current = undefined
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
    }
  }, [graphicsMode, imageCols, imageRows, info, loadAnotherClip, videoExists])

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

  return (
    <Panel title="Preview" width={width} paddingX={1} highlight={isPlaying}>
      <Box flexDirection="column" height={imageRows} width={imageCols} justifyContent="center" alignItems="center">
        {shownPng ? (
          Array.from({length: imageRows}, (_, idx) => <Text key={idx}>{' '.repeat(imageCols)}</Text>)
        ) : shownLines ? (
          shownLines.map((row, idx) => <Text key={idx}>{row}</Text>)
        ) : !thumbnailDone ? (
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
