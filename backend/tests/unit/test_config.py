from __future__ import annotations

import os

from app.config import Settings, load_dotenv


def test_load_dotenv_sets_missing_keys(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "# a comment\n"
        "\n"
        "ANTHROPIC_API_KEY=sk-test-123\n"
        "export PDF_READER_DATA_DIR='/some/dir'\n"
        'QUOTED="value with spaces"\n'
    )
    for key in ("ANTHROPIC_API_KEY", "PDF_READER_DATA_DIR", "QUOTED"):
        monkeypatch.delenv(key, raising=False)

    load_dotenv(env)

    assert os.environ["ANTHROPIC_API_KEY"] == "sk-test-123"
    assert os.environ["PDF_READER_DATA_DIR"] == "/some/dir"
    assert os.environ["QUOTED"] == "value with spaces"


def test_load_dotenv_does_not_override_existing_env(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("ANTHROPIC_API_KEY=from-file\n")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-shell")

    load_dotenv(env)

    assert os.environ["ANTHROPIC_API_KEY"] == "from-shell"


def test_load_dotenv_missing_file_is_noop(tmp_path):
    load_dotenv(tmp_path / "does-not-exist.env")  # must not raise


def test_settings_data_dir_from_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_READER_DATA_DIR", str(tmp_path / "store"))
    settings = Settings.from_env()
    assert settings.db_path == (tmp_path / "store" / "reader.db").resolve()
