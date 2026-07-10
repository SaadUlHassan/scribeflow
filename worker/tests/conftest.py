import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def tone_wav(tmp_path: Path) -> Path:
    """A 1-second 440 Hz stereo 44.1 kHz WAV, so normalization has work to do."""
    path = tmp_path / "tone.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=1",
            "-ar", "44100",
            "-ac", "2",
            str(path),
        ],
        capture_output=True,
        check=True,
    )
    return path


@pytest.fixture
def garbage_file(tmp_path: Path) -> Path:
    """Text bytes masquerading as an mp3."""
    path = tmp_path / "garbage.mp3"
    path.write_text("this is definitely not audio data")
    return path
