from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
import uuid
from typing import Optional
from urllib.parse import urlparse

import httpx
import websockets

from .asr import sentence_recognize

KEEP_FIELDS = {
    "user_id",
    "group_id",
    "message_type",
    "message_id",
    "raw_message",
    # "time",
    # "target_id",
}

DEFAULT_IGNORE_PREFIXES = ["/"]


def run_watch(args) -> int:
    url = os.getenv("NAPCAT_URL")
    if not url:
        sys.stderr.write("NAPCAT_URL is required for watch\n")
        return 2

    ignore_prefixes = args.ignore_startswith or []
    if not ignore_prefixes:
        ignore_prefixes = DEFAULT_IGNORE_PREFIXES

    if not args.verbose:
        logging.getLogger().setLevel(logging.ERROR)
    try:
        asyncio.run(_watch_loop(url, args.from_group, args.from_user, ignore_prefixes))
    except KeyboardInterrupt:
        if args.verbose:
            logging.info("watch stopped by user")
    return 0


async def _watch_loop(url: str, from_group: Optional[str], from_user: Optional[str], ignore_prefixes: list[str]) -> None:
    while True:
        try:
            logging.info("Connecting to Napcat event stream %s", url)
            async with websockets.connect(url, max_size=None) as ws:
                async for raw in ws:
                    logging.debug("WS raw frame: %s", raw)
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        logging.warning("Discard non-JSON frame")
                        continue
                    if not isinstance(event, dict):
                        continue
                    if event.get("post_type") != "message":
                        continue
                    if from_group and str(event.get("group_id")) != str(from_group):
                        continue
                    if from_user and str(event.get("user_id")) != str(from_user):
                        continue

                    text_content, record_file = _extract_text_and_record(event)
                    if text_content:
                        cleaned = _strip_cq_and_whitespace(text_content)
                        if not cleaned:
                            continue
                        text_content = cleaned
                        first_line = next((ln for ln in text_content.splitlines() if ln.strip()), text_content)
                        check_text = first_line.lstrip()
                        if ignore_prefixes and any(check_text.startswith(pfx) for pfx in ignore_prefixes):
                            continue
                    elif not record_file:
                        continue

                    resolved = await _resolve_text(text_content, record_file)
                    if resolved:
                        event["raw_message"] = resolved
                    elif not text_content:
                        # Voice without ASR (no creds or failed) -> skip entirely
                        continue
                    filtered = {k: v for k, v in event.items() if k in KEEP_FIELDS and v is not None}
                    sys.stdout.write(json.dumps(filtered, ensure_ascii=False))
                    sys.stdout.write("\n")
                    sys.stdout.flush()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logging.warning("Watch loop error %s, reconnecting in 3s", exc)
            await asyncio.sleep(3)


def _extract_text_and_record(event: dict) -> tuple[Optional[str], Optional[str]]:
    message = event.get("message")
    if isinstance(message, str):
        return message, None
    if not isinstance(message, list):
        return None, None
    text_parts = []
    record_file = None
    for item in message:
        if not isinstance(item, dict):
            continue
        seg_type = item.get("type", "")
        seg_data = item.get("data", {}) or {}
        if seg_type == "at":
            continue
        if seg_type == "text":
            txt = seg_data.get("text")
            if isinstance(txt, str):
                text_parts.append(txt)
        elif seg_type == "record" and record_file is None:
            rec_path = seg_data.get("path") or seg_data.get("file")
            if isinstance(rec_path, str) and rec_path.strip():
                record_file = rec_path.strip()
        elif seg_type in {"face", "image"}:
            continue
    return ("\n".join(text_parts) if text_parts else None, record_file)


async def _resolve_text(clean_text: Optional[str], record_file: Optional[str]) -> Optional[str]:
    """Normalize text, falling back to voice transcription when needed."""
    if clean_text:
        return clean_text
    if not record_file:
        return None

    secret_id = os.getenv("TENCENT_SECRET_ID", "").strip()
    secret_key = os.getenv("TENCENT_SECRET_KEY", "").strip()
    if not secret_id or not secret_key:
        return None

    try:
        audio_bytes = await _fetch_voice(record_file)
        if not audio_bytes:
            return None
        text = await sentence_recognize(audio_bytes, voice_format="mp3")
        return text
    except Exception as exc:  # noqa: BLE001
        logging.debug("ASR failed, skip message: %s", exc)
        return None


async def _fetch_voice(path: str) -> bytes:
    napcat_ws = os.getenv("NAPCAT_URL", "").strip()
    if not napcat_ws:
        return b""
    parsed = urlparse(napcat_ws)
    if parsed.scheme not in ("ws", "wss"):
        return b""
    scheme = "http" if parsed.scheme == "ws" else "https"
    hostname = parsed.hostname or "localhost"
    port = parsed.port or (80 if scheme == "http" else 443)
    base_url = f"{scheme}://{hostname}:{port}"

    payload = {"file": path, "out_format": "mp3"}
    echo = str(uuid.uuid4())
    request_body = {"action": "get_record", "params": payload, "echo": echo}

    try:
        async with websockets.connect(napcat_ws, max_size=None) as ws:
            await ws.send(json.dumps(request_body))
            response = None
            for _ in range(5):
                try:
                    response_raw = await asyncio.wait_for(ws.recv(), timeout=10)
                except Exception:
                    break
                try:
                    candidate = json.loads(response_raw)
                except Exception:
                    continue
                if not isinstance(candidate, dict):
                    continue
                if candidate.get("post_type") == "meta_event":
                    continue
                if candidate.get("echo") and candidate.get("echo") != echo:
                    continue
                if not candidate.get("status"):
                    continue
                response = candidate
                break
    except Exception:
        return b""

    if response is None:
        return b""

    data = response.get("data") or {}
    record_base64 = data.get("base64") if isinstance(data, dict) else None
    record_url = data.get("url") if isinstance(data, dict) else None
    record_file = data.get("file") if isinstance(data, dict) else None

    if record_base64:
        try:
            return base64.b64decode(record_base64)
        except Exception:
            return b""

    target = record_url or record_file
    if not target:
        return b""

    download_url = target if target.startswith(("http://", "https://")) else f"{base_url}/{target.lstrip('/')}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            file_resp = await client.get(download_url)
            file_resp.raise_for_status()
            return file_resp.content
        except Exception:
            return b""


def _read_file_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _strip_cq_and_whitespace(text: str) -> str:
    import re

    text = re.sub(r"\[CQ:(face|image)[^\]]*\]", "", text, flags=re.IGNORECASE)
    text = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return text.strip()


def _build_napcat_file_url(path: str) -> Optional[str]:
    marker = "/nt_qq_"
    idx = path.find(marker)
    if idx == -1:
        return None
    rel = path[idx:] if path.startswith(marker) else path[idx:]
    base = os.getenv("NAPCAT_FILE_BASE", "").strip()
    if not base:
        return None
    return f"{base.rstrip('/')}/{rel.lstrip('/')}"
