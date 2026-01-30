from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from typing import Optional
from urllib.parse import urlparse

import websockets

from .asr import sentence_recognize

KEEP_FIELDS = {
    "user_id",
    "group_id",
    "message_type",
    "message_id",
    "text",
    "images",
    # "time",
    # "target_id",
}

DEFAULT_IGNORE_PREFIXES = ["/"]
PASSTHROUGH_COMMANDS = {"/new", "/reset"}


async def watch_forever(
    url: str,
    from_group: Optional[str],
    from_user: Optional[str],
    ignore_prefixes: list[str],
    asr_enabled: bool,
    emit,
) -> None:
    while True:
        try:
            logging.info("Connecting to Napcat event stream %s", url)
            async with websockets.connect(url, max_size=None) as ws:
                while True:
                    raw = await ws.recv()
                    logging.debug("WS raw frame: %s", raw)
                    event = _try_parse_json(raw)
                    if not event:
                        continue
                    if event.get("post_type") != "message":
                        continue
                    if from_group and str(event.get("group_id")) != str(from_group):
                        continue
                    if from_user and str(event.get("user_id")) != str(from_user):
                        continue

                    text_content, images = await _extract_message_content(event, ws, url, asr_enabled)
                    if text_content:
                        first_line = next((ln for ln in text_content.splitlines() if ln.strip()), text_content)
                        check_text = first_line.lstrip()
                        passthrough_command = _is_passthrough_command(check_text)
                        if ignore_prefixes and not passthrough_command and any(
                            check_text.startswith(pfx) for pfx in ignore_prefixes
                        ):
                            continue
                    if not text_content and not images:
                        continue

                    if text_content:
                        event["text"] = text_content
                    if images:
                        event["images"] = images
                    filtered = {k: v for k, v in event.items() if k in KEEP_FIELDS and v is not None}
                    try:
                        maybe_coro = emit(filtered)
                        if asyncio.iscoroutine(maybe_coro):
                            await maybe_coro
                    except Exception as emit_exc:  # noqa: BLE001
                        logging.warning("Failed to emit event: %s", emit_exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logging.warning("Watch loop error %s, reconnecting in 3s", exc)
            await asyncio.sleep(3)


def _try_parse_json(raw: str) -> Optional[dict]:
    try:
        return json.loads(raw)
    except Exception:
        logging.debug("Failed to decode websocket frame as JSON")
        return None

def _event_to_receive_params(event: dict) -> dict:
    message_type = str(event.get("message_type") or "").lower()
    is_group = message_type == "group"
    chat_id = event.get("group_id") if is_group else event.get("user_id")
    return {
        "sender": event.get("user_id"),
        "chatId": chat_id,
        "isGroup": is_group,
        "text": event.get("text"),
        "messageId": event.get("message_id"),
        "images": event.get("images"),
    }


async def _extract_message_content(
    event: dict, ws, napcat_ws: str, allow_asr: bool
) -> tuple[Optional[str], list[str]]:
    message = event.get("message")
    if isinstance(message, str):
        return message, []
    if not isinstance(message, list):
        return None, []
    text_parts = []
    images = []
    record_text = None
    for item in message:
        if not isinstance(item, dict):
            continue

        # sub_type 0: icons
        sub_type = item.get("sub_type", 0)
        if sub_type == 1:
            continue

        seg_type = item.get("type", "")
        seg_data = item.get("data", {}) or {}
        if seg_type == "at":
            continue
        if seg_type == "text":
            txt = seg_data.get("text")
            if isinstance(txt, str):
                text_parts.append(txt)
        elif seg_type == "record" and record_text is None:
            rec_path = seg_data.get("file")
            if isinstance(rec_path, str) and rec_path.strip():
                record_text = await _resolve_text(None, rec_path.strip(), ws, napcat_ws, allow_asr)
        elif seg_type == "face":
            continue
        elif seg_type == "image":
            image_url = seg_data.get("url", "")
            if not image_url:
                continue

            images.append(image_url)

    if record_text:
        text_parts.append(record_text)

    cleaned = "\n".join(line.strip() for line in text_parts if line and line.strip())
    return cleaned if cleaned else None, images


async def _resolve_text(
    clean_text: Optional[str], record_file: Optional[str], ws, napcat_ws: str, allow_asr: bool
) -> Optional[str]:
    """Normalize text, falling back to voice transcription when needed."""
    if clean_text:
        return clean_text
    if not record_file or not allow_asr:
        return None

    try:
        audio_bytes = await _fetch_voice(record_file, ws, napcat_ws)
        if not audio_bytes:
            return None
        text = await sentence_recognize(audio_bytes, voice_format="mp3")
        return text
    except Exception as exc:  # noqa: BLE001
        logging.debug("ASR failed, skip message: %s", exc)
        return None


async def _fetch_voice(path: str, ws, napcat_ws: str) -> bytes:
    if not napcat_ws:
        return b""
    parsed = urlparse(napcat_ws)
    if parsed.scheme not in ("ws", "wss"):
        return b""

    payload = {"file": path, "out_format": "mp3"}
    echo = str(uuid.uuid4())
    request_body = {"action": "get_record", "params": payload, "echo": echo}

    try:
        await ws.send(json.dumps(request_body))
    except Exception:
        return b""

    response = None
    for _ in range(10):
        try:
            response_raw = await asyncio.wait_for(ws.recv(), timeout=10)
        except Exception:
            break
        candidate = _try_parse_json(response_raw)
        if not candidate:
            continue
        if candidate.get("post_type") == "meta_event":
            continue
        if candidate.get("echo") and candidate.get("echo") != echo:
            continue
        if not candidate.get("status"):
            continue
        response = candidate
        break

    if response is None:
        return b""

    data = response.get("data") or {}
    status = response.get("status")
    if status != "ok":
        logging.debug("Napcat get_record full response: %s", response)
        return b""
    record_base64 = data.get("base64") if isinstance(data, dict) else None

    if record_base64:
        try:
            return base64.b64decode(record_base64)
        except Exception:
            return b""

    # No base64 available
    return b""


def _is_passthrough_command(text: str) -> bool:
    return text.strip() in PASSTHROUGH_COMMANDS
