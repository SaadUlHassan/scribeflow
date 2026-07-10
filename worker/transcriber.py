"""faster-whisper wrapper with long-file chunking.

The model is loaded once per process (lazy singleton). Chunk planning,
timestamp offsetting, and segment shaping are pure functions so tests
never need the model.
"""

from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import audio
from log import get_logger
from settings import Settings

logger = get_logger("transcriber")

RawSegment = tuple[float, float, str]
Chunk = tuple[float, float]  # (start_sec, length_sec)
OnProgress = Callable[[float], None]

_model: Any = None


def get_model(settings: Settings) -> Any:
    """Lazy singleton — loading takes seconds and must never happen per job."""
    global _model
    if _model is None:
        from faster_whisper import WhisperModel  # deferred: heavy import, absent in unit tests

        logger.info("loading whisper model=%s", settings.whisper_model)
        _model = WhisperModel(settings.whisper_model, device="cpu", compute_type="int8")
    return _model


def plan_chunks(duration: float, chunk_sec: float) -> list[Chunk]:
    """Fixed-boundary chunks covering [0, duration); the last one may be short."""
    chunks: list[Chunk] = []
    start = 0.0
    while start < duration:
        chunks.append((start, min(chunk_sec, duration - start)))
        start += chunk_sec
    return chunks


def offset_segments(raw_segments: Iterable[RawSegment], offset_sec: float) -> list[RawSegment]:
    """Shift chunk-relative timestamps to be relative to the original file start."""
    return [(start + offset_sec, end + offset_sec, text) for start, end, text in raw_segments]


def merge_chunks(chunk_results: Iterable[tuple[float, list[RawSegment]]]) -> list[RawSegment]:
    """Merge per-chunk raw segments, applying each chunk's start offset."""
    merged: list[RawSegment] = []
    for chunk_start, raw_segments in chunk_results:
        merged.extend(offset_segments(raw_segments, chunk_start))
    return merged


def shape_segments(raw_segments: Iterable[RawSegment]) -> list[dict[str, Any]]:
    """Renumber ids and round timestamps to 2 decimals (spec transcript shape)."""
    return [
        {
            "id": idx,
            "start": round(start, 2),
            "end": round(end, 2),
            "text": text.strip(),
        }
        for idx, (start, end, text) in enumerate(raw_segments)
    ]


def build_transcript(
    segments: list[dict[str, Any]], language: str, duration: float
) -> dict[str, Any]:
    return {
        "text": " ".join(s["text"] for s in segments),
        "language": language,
        "duration": round(duration, 2),
        "segments": segments,
    }


def _transcribe_wav(
    model: Any, wav_path: Path, duration: float, on_progress: OnProgress | None
) -> tuple[list[RawSegment], str]:
    """Run inference on one WAV; progress is the 0..1 fraction of this file."""
    segments_iter, info = model.transcribe(str(wav_path), vad_filter=True)
    raw: list[RawSegment] = []
    for segment in segments_iter:  # generator: inference happens during iteration
        raw.append((segment.start, segment.end, segment.text))
        if on_progress and duration > 0:
            on_progress(min(segment.end / duration, 1.0))
    return raw, info.language


def _scaled_progress(
    on_progress: OnProgress | None, index: int, total: int
) -> OnProgress | None:
    """Map a within-chunk fraction onto the whole job (chunk i of n)."""
    if on_progress is None:
        return None

    def scaled(fraction: float) -> None:
        on_progress((index + fraction) / total)

    return scaled


def transcribe(
    wav_path: Path,
    settings: Settings,
    duration: float,
    on_progress: OnProgress | None = None,
) -> dict[str, Any]:
    """Transcribe a normalized WAV, chunking when it exceeds the threshold.

    Chunk cuts are fixed-boundary; whisper's VAD mitigates mid-word cuts
    (tradeoff documented in the README).
    """
    model = get_model(settings)
    if duration > settings.chunk_threshold_sec:
        chunks = plan_chunks(duration, settings.chunk_sec)
    else:
        chunks = [(0.0, duration)]

    merged: list[RawSegment] = []
    language: str | None = None
    for index, (chunk_start, chunk_length) in enumerate(chunks):
        if len(chunks) == 1:
            chunk_path = wav_path
        else:
            chunk_path = audio.slice_wav(wav_path, chunk_start, chunk_length, index)

        raw, chunk_language = _transcribe_wav(
            model, chunk_path, chunk_length, _scaled_progress(on_progress, index, len(chunks))
        )
        language = language or chunk_language
        merged.extend(offset_segments(raw, chunk_start))

        if chunk_path != wav_path:
            chunk_path.unlink(missing_ok=True)
        if len(chunks) > 1:
            logger.info(
                "chunk %d/%d transcribed segments=%d", index + 1, len(chunks), len(raw)
            )

    transcript = build_transcript(shape_segments(merged), language or "unknown", duration)
    logger.info(
        "transcribed file=%s language=%s duration=%.2f segments=%d chunks=%d",
        wav_path.name,
        transcript["language"],
        transcript["duration"],
        len(transcript["segments"]),
        len(chunks),
    )
    return transcript
