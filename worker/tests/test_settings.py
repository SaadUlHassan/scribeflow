from settings import Settings


def test_settings_load_from_env(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@h:5432/db")
    monkeypatch.setenv("RABBITMQ_URL", "amqp://u:p@h:5672/")

    settings = Settings()

    assert settings.database_url == "postgres://u:p@h:5432/db"
    assert settings.rabbitmq_url == "amqp://u:p@h:5672/"
    assert settings.audio_dir == "/data/audio"
    assert settings.chunk_threshold_sec == 600
    assert settings.chunk_sec == 300
    assert settings.jobs_queue == "transcription.jobs"


def test_settings_env_overrides(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@h:5432/db")
    monkeypatch.setenv("RABBITMQ_URL", "amqp://u:p@h:5672/")
    monkeypatch.setenv("CHUNK_SEC", "120")
    monkeypatch.setenv("WHISPER_MODEL", "tiny")

    settings = Settings()

    assert settings.chunk_sec == 120
    assert settings.whisper_model == "tiny"
