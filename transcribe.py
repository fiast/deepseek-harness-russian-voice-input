"""Transcribe one Russian recording with faster-whisper.

Reads a browser recording (WebM/Opus, Ogg, WAV, MP3 or MP4) from stdin, decodes it with the
PyAV runtime shipped inside faster-whisper, and prints exactly one JSON line on stdout. The
model is loaded from RU_VOICE_MODEL_DIR so repeated runs reuse the same download.
"""

import base64
import io
import json
import os
import re
import sys
import time
from pathlib import Path

MODEL_NAME = os.environ.get("RU_VOICE_MODEL", "small")
MODEL_DIR = os.environ.get("RU_VOICE_MODEL_DIR") or None
LANGUAGE = os.environ.get("RU_VOICE_LANGUAGE", "ru")
# 0 lets the loader pick a hybrid-CPU-friendly default; 8 threads measured fastest on a 12-thread i5.
THREADS = int(os.environ.get("RU_VOICE_THREADS", "0") or 0)
# Greedy decoding is ~10% faster here and matched beam=5 on Russian dictation samples.
BEAM_SIZE = max(1, int(os.environ.get("RU_VOICE_BEAM", "1") or 1))
PROMPT = (
    "Это разговорная русская речь. Расставляй знаки препинания: "
    "заглавные буквы, точки, запятые, вопросительные и восклицательные знаки."
)
SPACE_BEFORE_PUNCTUATION = re.compile(r"\s+([,.!?;:…])")


def model_is_cached():
    """True when the download root already holds a complete snapshot of the model."""
    if MODEL_DIR is None:
        return False
    root = Path(MODEL_DIR)
    if not root.is_dir():
        return False
    for cache in root.glob("models--*"):
        snapshots = cache / "snapshots"
        if snapshots.is_dir() and any(snapshots.glob("*/model.bin")):
            return True
        if (cache / "model.bin").is_file():
            return True
    return (root / "model.bin").is_file()


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model():
    from faster_whisper import WhisperModel

    threads = THREADS if THREADS > 0 else max(1, min(8, os.cpu_count() or 4))
    # Once the snapshot exists, never touch the network: dictation stays fully offline.
    local_only = model_is_cached()
    return WhisperModel(
        MODEL_NAME,
        device="cpu",
        compute_type="int8",
        download_root=MODEL_DIR,
        cpu_threads=threads,
        local_files_only=local_only,
    )


def transcribe(model, audio):
    started = time.monotonic()
    segments, info = model.transcribe(
        io.BytesIO(audio),
        language=LANGUAGE,
        beam_size=BEAM_SIZE,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        initial_prompt=PROMPT,
    )
    parts = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            parts.append(text)
    text = " ".join(parts)
    text = SPACE_BEFORE_PUNCTUATION.sub(r"\1", re.sub(r"\s+", " ", text)).strip()
    return {
        "ok": True,
        "text": text,
        "durationSeconds": round(float(info.duration or 0.0), 1),
        "elapsedSeconds": round(time.monotonic() - started, 2),
        "language": getattr(info, "language", LANGUAGE),
    }


def serve(model):
    """Read one JSON request per line and answer on the same stream, model kept in memory."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            audio = base64.b64decode(request.get("audio") or "")
            if not audio:
                raise ValueError("Пустая запись")
            payload = transcribe(model, audio)
        except Exception as error:  # noqa: BLE001 - reported to the Host
            payload = {"ok": False, "error": str(error) or error.__class__.__name__}
        payload["id"] = request_id
        emit(payload)


def main():
    warmup = "--warmup" in sys.argv
    server = "--server" in sys.argv
    audio = b"" if (warmup or server) else sys.stdin.buffer.read()
    if not warmup and not server and not audio:
        emit({"ok": False, "error": "Пустая запись"})
        return
    model = load_model()
    if warmup:
        emit({"ok": True, "warmed": True, "model": MODEL_NAME})
        return
    if server:
        serve(model)
        return
    emit(transcribe(model, audio))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - the Host turns this into a user-facing message
        emit({"ok": False, "error": str(error) or error.__class__.__name__})
