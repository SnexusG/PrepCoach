"""PrepCoach speech-to-text helper: faster-whisper behind a JSON-lines protocol on stdin/stdout.

Started (and kept alive) by the Node server. One request per line:
  {"id": 1, "audio": "<base64 float32 PCM, 16 kHz mono>", "prompt": "words to expect"}
One reply per line:
  {"id": 1, "text": "...", "ms": 312}            or  {"id": 1, "error": "..."}
On start it prints {"type": "ready", "device": "cuda", "model": "...", "computeType": "..."} (or
{"type": "fatal", "error": "..."}). Everything else (logs, warnings) goes to stderr, so stdout stays parseable.

Usage: python whisper_server.py --model large-v3-turbo --device auto --compute-type auto
       --cpu-model small.en --download-root data/models/whisper [--beam-size 5]
       python whisper_server.py --check     (load the model, transcribe a second of silence, print the device)
"""

import argparse
import base64
import glob
import json
import os
import site
import sys
import time


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def add_cuda_dll_dirs():
    """pip's nvidia-cublas-cu12 / nvidia-cudnn-cu12 wheels put DLLs in site-packages/nvidia/*/bin (Windows)."""
    if os.name != "nt":
        return
    roots = list(site.getsitepackages()) + [site.getusersitepackages()]
    for root in roots:
        for bin_dir in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            try:
                os.add_dll_directory(bin_dir)
            except (OSError, AttributeError):
                pass
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def load_model(args):
    from faster_whisper import WhisperModel

    attempts = []
    if args.device in ("auto", "cuda"):
        attempts.append(("cuda", args.model, "int8_float16" if args.compute_type == "auto" else args.compute_type))
    if args.device in ("auto", "cpu"):
        attempts.append(("cpu", args.cpu_model if args.device == "auto" else args.model,
                         "int8" if args.compute_type == "auto" or args.device == "auto" else args.compute_type))
    last_error = None
    for device, name, compute_type in attempts:
        try:
            log(f"loading {name} on {device} ({compute_type})…")
            model = WhisperModel(name, device=device, compute_type=compute_type, download_root=args.download_root)
            # Warm up (and surface missing CUDA libraries now, not on the first real request).
            import numpy as np
            list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en", beam_size=1)[0])
            return model, device, name, compute_type
        except Exception as e:  # noqa: BLE001 — report and try the next option
            last_error = f"{device}: {e}"
            log(f"could not load on {device}: {e}")
    raise RuntimeError(last_error or "no device to try")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="large-v3-turbo")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--compute-type", default="auto")
    p.add_argument("--cpu-model", default="small.en")
    p.add_argument("--download-root", default=None)
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument("--check", action="store_true")
    args = p.parse_args()

    add_cuda_dll_dirs()
    try:
        import numpy as np
        model, device, name, compute_type = load_model(args)
    except Exception as e:  # noqa: BLE001
        reply({"type": "fatal", "error": str(e)})
        return 1

    ready = {"type": "ready", "device": device, "model": name, "computeType": compute_type}
    reply(ready)
    if args.check:
        return 0

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            audio = np.frombuffer(base64.b64decode(req["audio"]), dtype=np.float32)
            t0 = time.perf_counter()
            segments, _info = model.transcribe(
                audio,
                language="en",
                beam_size=args.beam_size,
                initial_prompt=req.get("prompt") or None,
                condition_on_previous_text=False,
                without_timestamps=True,
                vad_filter=False,  # the browser already cut the audio to speech
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            reply({"id": req_id, "text": text, "ms": round((time.perf_counter() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001 — one bad request must not kill the helper
            reply({"id": req_id, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
