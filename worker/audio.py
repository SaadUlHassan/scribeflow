"""Audio validation and normalization via ffprobe/ffmpeg subprocesses.

These calls block; the consumer runs them in a thread (asyncio.to_thread).
"""

import json
import subprocess
from pathlib import Path

STDERR_TAIL_CHARS = 400
# Timeouts keep a hung ffmpeg/ffprobe from deadlocking the prefetch-1 worker.
PROBE_TIMEOUT_SEC = 60
NORMALIZE_TIMEOUT_SEC = 600


class AudioProcessingError(Exception):
    """Raised for invalid audio input or ffmpeg failure; message goes to jobs.error."""


def _run(cmd: list[str], timeout_sec: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
    except subprocess.TimeoutExpired as exc:
        raise AudioProcessingError(f"{cmd[0]} timed out after {timeout_sec}s") from exc


def probe(path: str | Path) -> float:
    """Validate that the file has an audio stream and return its duration in seconds."""
    result = _run(
        [
            "ffprobe",
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        PROBE_TIMEOUT_SEC,
    )
    if result.returncode != 0:
        raise AudioProcessingError(f"ffprobe rejected the file: {_tail(result.stderr)}")

    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    if not any(s.get("codec_type") == "audio" for s in streams):
        raise AudioProcessingError("file contains no audio stream")

    duration_raw = data.get("format", {}).get("duration")
    if duration_raw is None:
        raise AudioProcessingError("could not determine audio duration")
    return float(duration_raw)


def normalize(src: str | Path, out_dir: Path) -> Path:
    """Convert any input to the canonical 16 kHz mono 16-bit PCM WAV."""
    out_path = out_dir / "normalized.wav"
    result = _run(
        [
            "ffmpeg",
            "-y",
            "-i", str(src),
            "-vn",
            "-ar", "16000",
            "-ac", "1",
            "-sample_fmt", "s16",
            str(out_path),
        ],
        NORMALIZE_TIMEOUT_SEC,
    )
    if result.returncode != 0:
        raise AudioProcessingError(f"ffmpeg normalization failed: {_tail(result.stderr)}")
    return out_path


def _tail(stderr: str) -> str:
    return stderr.strip()[-STDERR_TAIL_CHARS:]
