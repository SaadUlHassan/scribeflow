import json
import subprocess
from pathlib import Path

import pytest

from audio import AudioProcessingError, _run, normalize, probe


def ffprobe_stream(path: Path) -> dict:
    result = subprocess.run(
        [
            "ffprobe",
            "-v", "error",
            "-print_format", "json",
            "-show_streams",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)["streams"][0]


def test_probe_returns_duration(tone_wav):
    assert probe(tone_wav) == pytest.approx(1.0, abs=0.1)


def test_probe_rejects_garbage(garbage_file):
    with pytest.raises(AudioProcessingError):
        probe(garbage_file)


def test_probe_rejects_missing_file(tmp_path):
    with pytest.raises(AudioProcessingError):
        probe(tmp_path / "does-not-exist.mp3")


def test_normalize_produces_16khz_mono_s16(tone_wav, tmp_path):
    out = normalize(tone_wav, tmp_path)

    stream = ffprobe_stream(out)
    assert stream["codec_name"] == "pcm_s16le"
    assert stream["sample_rate"] == "16000"
    assert stream["channels"] == 1


def test_normalize_rejects_garbage(garbage_file, tmp_path):
    with pytest.raises(AudioProcessingError):
        normalize(garbage_file, tmp_path)


def test_run_maps_timeout_to_typed_error():
    with pytest.raises(AudioProcessingError, match="timed out"):
        _run(["sleep", "5"], timeout_sec=1)
