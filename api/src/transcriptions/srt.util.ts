import type { TranscriptSegment } from './entities/job.entity';

export type SubtitleFormat = 'srt' | 'vtt';

/** Seconds (float) -> "HH:MM:SS<sep>mmm". SRT uses ",", VTT uses ".". */
export function formatTimestamp(seconds: number, separator: ',' | '.'): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`
  );
}

export function toSrt(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n` +
        `${formatTimestamp(segment.start, ',')} --> ${formatTimestamp(segment.end, ',')}\n` +
        `${segment.text}\n`,
    )
    .join('\n');
}

export function toVtt(segments: TranscriptSegment[]): string {
  const cues = segments
    .map(
      (segment, index) =>
        `${index + 1}\n` +
        `${formatTimestamp(segment.start, '.')} --> ${formatTimestamp(segment.end, '.')}\n` +
        `${segment.text}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${cues}`;
}
