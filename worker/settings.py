"""Typed environment configuration for the worker."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All worker configuration comes from environment variables."""

    database_url: str
    rabbitmq_url: str
    audio_dir: str = "/data/audio"
    whisper_model: str = "small"
    chunk_threshold_sec: int = 600
    chunk_sec: int = 300

    # RabbitMQ topology names (fixed contract, see shared/message-schema.md)
    exchange: str = "scribeflow"
    dlx_exchange: str = "scribeflow.dlx"
    jobs_queue: str = "transcription.jobs"
    retry_queue: str = "transcription.retry"
    dead_queue: str = "transcription.dead"

    startup_retry_max: int = 30
    startup_retry_delay_sec: float = 2.0
    # On SIGTERM, wait this long for the in-flight job before letting the
    # broker redeliver it; compose stop_grace_period must exceed this.
    shutdown_grace_sec: float = 55.0


def load_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # populated from env
