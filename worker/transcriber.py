"""faster-whisper wrapper.

The model is loaded once per process (lazy singleton). Segment shaping is
kept in pure functions so tests never need the model.
"""

from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from log import get_logger
from settings import Settings

logger = get_logger("transcriber")

RawSegment = tuple[float, float, str]
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


def transcribe(
    wav_path: Path, settings: Settings, on_progress: OnProgress | None = None
) -> dict[str, Any]:
    """Transcribe a normalized WAV; reports progress as a 0..1 fraction."""
    model = get_model(settings)
    segments_iter, info = model.transcribe(str(wav_path), vad_filter=True)

    raw: list[RawSegment] = []
    for segment in segments_iter:  # generator: inference happens during iteration
        raw.append((segment.start, segment.end, segment.text))
        if on_progress and info.duration > 0:
            on_progress(min(segment.end / info.duration, 1.0))

    transcript = build_transcript(shape_segments(raw), info.language, info.duration)
    logger.info(
        "transcribed file=%s language=%s duration=%.2f segments=%d",
        wav_path.name,
        transcript["language"],
        transcript["duration"],
        len(transcript["segments"]),
    )
    return transcript
