import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import wave

import numpy as np
import websockets


def synthesize_test_wav(path: str, text: str) -> bool:
    ps = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"$s.SetOutputToWaveFile('{path}'); "
        f"$s.Speak('{text}'); "
        "$s.Dispose()"
    )
    proc = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True)
    return proc.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 1000


def resample_wav_to_16k_int16(wav_path: str) -> bytes:
    with wave.open(wav_path, "rb") as wf:
        rate = wf.getframerate()
        channels = wf.getnchannels()
        frames = wf.readframes(wf.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        ratio = rate / 16000.0
        new_len = int(round(len(samples) / ratio))
        idx = np.linspace(0, len(samples) - 1, new_len)
        samples = np.interp(idx, np.arange(len(samples)), samples)
    pcm16 = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
    return pcm16.tobytes()


def multipart_upload(url: str, field_name: str, filename: str, file_bytes: bytes, mode: str) -> dict:
    boundary = f"----WebKitFormBoundary{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="mode"\r\n\r\n'
        f"{mode}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8") + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"HTTP {err.code}: {err.read().decode('utf-8', errors='replace')}") from err


async def test_ws(ws_url: str, pcm_bytes: bytes) -> list[dict]:
    async with websockets.connect(ws_url) as ws:
        ready = json.loads(await ws.recv())
        print("WS READY:", json.dumps(ready))
        assert ready["type"] == "ready"

        await ws.send(json.dumps({"type": "config", "mode": "multilingual", "silenceMs": 500}))
        ack = json.loads(await ws.recv())
        assert ack["type"] == "config_ack"

        chunk_size = 4096
        for i in range(0, len(pcm_bytes), chunk_size):
            await ws.send(pcm_bytes[i : i + chunk_size])
            await asyncio.sleep(0.01)

        await ws.send(b"\x00" * (16000 * 2))
        await ws.send(json.dumps({"type": "flush"}))

        events = []
        while True:
            msg = json.loads(await ws.recv())
            events.append(msg)
            if msg.get("type") == "flushed":
                break
        return events


def main() -> None:
    port = 7877
    env = os.environ.copy()
    env["WHISPER_MODEL"] = "tiny"
    backend_dir = os.path.dirname(os.path.abspath(__file__))

    log_file = tempfile.NamedTemporaryFile(mode="w+", suffix=".log", delete=False)
    log_path = log_file.name
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=backend_dir,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
    )

    try:
        health = None
        for _ in range(90):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                    data = json.loads(r.read().decode("utf-8"))
                    if data.get("status") == "ok":
                        health = data
                        break
            except Exception:
                pass
            time.sleep(1)

        if health is None:
            log_file.flush()
            with open(log_path, "r", encoding="utf-8", errors="replace") as lf:
                print("SERVER LOG:\n" + lf.read(), flush=True)
        assert health is not None, "Backend failed to become ready within 90s"
        print("HEALTH:", json.dumps(health), flush=True)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name

        try:
            ok = synthesize_test_wav(
                wav_path,
                "Hello team, today we are testing real time speech to text transcription.",
            )
            assert ok, "Windows SAPI failed to synthesize test wav"

            with open(wav_path, "rb") as f:
                wav_bytes = f.read()

            http_res = multipart_upload(
                f"http://127.0.0.1:{port}/api/transcribe",
                "file",
                "test.wav",
                wav_bytes,
                "multilingual",
            )
            print("HTTP TRANSCRIBE:", json.dumps(http_res, ensure_ascii=False), flush=True)
            assert "speech" in http_res["text"].lower() or len(http_res["text"]) > 10

            pcm_bytes = resample_wav_to_16k_int16(wav_path)
            events = asyncio.run(test_ws(f"ws://127.0.0.1:{port}/ws/transcribe?mode=multilingual", pcm_bytes))
            finals = [e for e in events if e.get("type") == "final"]
            print("WS FINALS:", json.dumps(finals, ensure_ascii=False), flush=True)
            assert len(finals) >= 1 and len(finals[0]["text"]) > 10
        finally:
            if os.path.exists(wav_path):
                os.remove(wav_path)

        print("ALL_BACKEND_TESTS_PASSED", flush=True)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        log_file.close()
        try:
            if os.path.exists(log_path):
                os.remove(log_path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
