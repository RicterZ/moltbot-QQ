from __future__ import annotations

import argparse
import asyncio
import functools
import json
import logging
import os
import sys
from pathlib import Path
from typing import List, Optional

from .client import DEFAULT_TIMEOUT, NapcatRelayClient, send_group_forward_message, send_group_message, send_private_forward_message, send_private_message
from .messages import FileMessage, ForwardNode, ImageMessage, ReplyMessage, TextMessage, VideoMessage
from .video import download_and_transcode


def _segment_action(segment_type: str):
    """Create an argparse action that appends (type, value) while preserving CLI order."""

    class _SegmentAction(argparse.Action):
        def __call__(self, parser, namespace, values, option_string=None):
            segments = getattr(namespace, self.dest, []) or []
            segments.append((segment_type, values))
            setattr(namespace, self.dest, segments)

    return _SegmentAction


def _load_dotenv_if_present() -> None:
    env_path = Path.cwd() / ".env"
    if not env_path.is_file():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("export "):
                stripped = stripped[len("export "):].strip()
            if "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            os.environ[key] = value
            logging.info(f"Load env: {key} / {value}")
    except OSError as exc:
        logging.info("Skipping .env load: %s", exc)


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "%(asctime)s [%(levelname)s] %(message)s"
    log_path = Path.cwd() / "nap-msg.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")

    logging.basicConfig(level=level, format=fmt, handlers=[file_handler], force=True)


def _add_segment_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("-t", "--text", dest="segments", action=_segment_action("text"), help="Text segment")
    parser.add_argument("-i", "--image", dest="segments", action=_segment_action("image"), help="Image file path or URL")
    parser.add_argument("-f", "--file", dest="segments", action=_segment_action("file"), help="File path to upload")
    parser.add_argument("-v", "--video", dest="segments", action=_segment_action("video"), help="Video file path")
    parser.add_argument(
        "--video-url",
        dest="segments",
        action=_segment_action("video-url"),
        help="Video/stream URL (downloaded via yt-dlp and transcoded to QQ-compatible MP4)",
    )
    parser.add_argument(
        "--video-duration",
        type=int,
        default=None,
        dest="video_duration",
        help="Max seconds to capture from a stream/video (default: 30)",
    )
    parser.add_argument("-r", "--reply", dest="segments", action=_segment_action("reply"), help="Reply to a message id")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nap-msg",
        description="CLI tool for sending messages via Napcat WebSocket.",
    )
    parser.add_argument(
        "--napcat-url",
        default=os.getenv("NAPCAT_URL"),
        help="Napcat WebSocket endpoint (env NAPCAT_URL).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help=f"Response wait timeout in seconds (default: env NAPCAT_TIMEOUT or {DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    send_private = subparsers.add_parser("send", help="Send a private message")
    send_private.add_argument("user_id", help="Target QQ user id")
    _add_segment_args(send_private)
    send_private.add_argument(
        "--type",
        choices=["normal", "forward"],
        default="normal",
        help="Send as normal message or as a forward message.",
    )
    send_private.add_argument(
        "--forward",
        action="store_true",
        help="Shortcut for --type forward.",
    )

    send_group = subparsers.add_parser("send-group", help="Send a group message")
    send_group.add_argument("group_id", help="Target QQ group id")
    _add_segment_args(send_group)
    send_group.add_argument(
        "--type",
        choices=["normal", "forward"],
        default="normal",
        help="Send as normal message or as a forward message.",
    )
    send_group.add_argument(
        "--forward",
        action="store_true",
        help="Shortcut for --type forward.",
    )

    return parser


def _build_parts_and_errors(segments: List[tuple], video_duration: Optional[int] = None) -> tuple[List[object], List[dict], List[tuple]]:
    parts: List[object] = []
    errors: List[dict] = []
    video_seg = functools.partial(_video_segment, duration=video_duration)
    video_url_seg = functools.partial(_video_url_segment, duration=video_duration)
    builders = {
        "reply": ReplyMessage,
        "text": TextMessage,
        "image": ImageMessage,
        "video": video_seg,
        "file": FileMessage,
        "video-url": video_url_seg,
    }
    for seg_type, value in segments:
        builder = builders.get(seg_type)
        if not builder:
            continue
        try:
            part = builder(value)
        except Exception as exc:  # noqa: BLE001
            logging.exception("Failed to build segment %s", seg_type)
            errors.append({"segment": seg_type, "value": value, "error": str(exc)})
            continue
        if part is None:
            errors.append({"segment": seg_type, "value": value, "error": "no content built"})
            continue
        parts.append(part)
    return parts, errors, segments


def _build_forward_nodes(parts: List[object]) -> List[ForwardNode]:
    user_id = os.getenv("NAPCAT_FORWARD_USER_ID", "")
    nickname = os.getenv("NAPCAT_FORWARD_NICKNAME", "メイド")
    return [ForwardNode(user_id, nickname, [part]) for part in parts]


def _log_build_errors(errors: List[dict], raw_segments: List[tuple]) -> None:
    original = "; ".join(f"{seg}:{val}" for seg, val in raw_segments) if raw_segments else "none"
    logging.error("Message content build failed; original segments: %s", original)
    for err in errors:
        logging.error(
            "Segment build failed: %s: %s => %s",
            err.get("segment"),
            err.get("value"),
            err.get("error"),
        )


def _serialize_parts(parts: List[object]) -> List[dict]:
    return [part.as_dict() if hasattr(part, "as_dict") else part for part in parts]


def _video_segment(value: str, duration: Optional[int] = None) -> Optional[VideoMessage]:
    """Local file path → VideoMessage directly; any URL → download and transcode first."""
    if value.startswith(("http://", "https://", "rtsp://", "rtmp://")):
        return _video_url_segment(value, duration=duration)
    return VideoMessage(value)


def _video_url_segment(video_url: str, duration: Optional[int] = None) -> Optional[VideoMessage]:
    """Download *video_url*, transcode to QQ-compatible MP4, return a VideoMessage."""
    from .video import LIVE_CLIP_SECONDS
    secs = duration or LIVE_CLIP_SECONDS
    print(f"Downloading and processing video (up to {secs}s), please wait...")
    path = download_and_transcode(video_url, duration=secs)
    if not path:
        return None
    return VideoMessage(str(path))


def _print_response(response: dict) -> None:
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _run_send_group(args: argparse.Namespace) -> int:
    parts, errors, raw_segments = _build_parts_and_errors(
        getattr(args, "segments", []), getattr(args, "video_duration", None)
    )
    if not parts and not errors:
        return 2

    is_forward = args.forward or args.type == "forward"
    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    if errors:
        _log_build_errors(errors, raw_segments)
        if not parts:
            return 1

    try:
        if is_forward:
            nodes = _build_forward_nodes(parts)
            response = asyncio.run(send_group_forward_message(client, args.group_id, nodes))
        else:
            response = asyncio.run(send_group_message(client, args.group_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


def _run_send_private(args: argparse.Namespace) -> int:
    parts, errors, raw_segments = _build_parts_and_errors(
        getattr(args, "segments", []), getattr(args, "video_duration", None)
    )
    if not parts and not errors:
        return 2

    is_forward = args.forward or args.type == "forward"
    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    if errors:
        _log_build_errors(errors, raw_segments)
        if not parts:
            return 1

    try:
        if is_forward:
            nodes = _build_forward_nodes(parts)
            response = asyncio.run(send_private_forward_message(client, args.user_id, nodes))
        else:
            response = asyncio.run(send_private_message(client, args.user_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


def main(argv: list[str] | None = None) -> int:
    _load_dotenv_if_present()
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)

    if args.command == "send":
        return _run_send_private(args)
    if args.command == "send-group":
        return _run_send_group(args)

    parser.error(f"Unknown command {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
