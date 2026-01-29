from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import List, Optional

from .client import DEFAULT_TIMEOUT, NapcatRelayClient, send_group_forward_message, send_group_message, send_private_message
from .messages import FileMessage, ForwardNode, ImageMessage, ReplyMessage, TextMessage, VideoMessage
import websockets


def _segment_action(segment_type: str):
    """
    Factory to create an argparse action that appends (order, type, value) tuples,
    preserving the order segments appear on the command line.
    """

    class _SegmentAction(argparse.Action):
        _counter = 0

        def __call__(self, parser, namespace, values, option_string=None):
            segments = getattr(namespace, self.dest, None)
            if segments is None:
                segments = []
            segments.append((_SegmentAction._counter, segment_type, values))
            _SegmentAction._counter += 1
            setattr(namespace, self.dest, segments)

    return _SegmentAction


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s [%(levelname)s] %(message)s")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nap-msg",
        description="Relay CLI for sending messages from moltbot to Napcat.",
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
    send_private.add_argument("-t", "--text", dest="segments", action=_segment_action("text"), help="Text segment")
    send_private.add_argument("-i", "--image", dest="segments", action=_segment_action("image"), help="Image file path or URL")
    send_private.add_argument("-f", "--file", dest="segments", action=_segment_action("file"), help="File path to upload")
    send_private.add_argument("-v", "--video", dest="segments", action=_segment_action("video"), help="Video file path or URL")
    send_private.add_argument("-r", "--reply", dest="segments", action=_segment_action("reply"), help="Reply to a message id")

    send_group = subparsers.add_parser("send-group", help="Send a group message")
    send_group.add_argument("group_id", help="Target QQ group id")
    send_group.add_argument("-t", "--text", dest="segments", action=_segment_action("text"), help="Text segment")
    send_group.add_argument("-i", "--image", dest="segments", action=_segment_action("image"), help="Image file path or URL")
    send_group.add_argument("-f", "--file", dest="segments", action=_segment_action("file"), help="File path to upload")
    send_group.add_argument("-v", "--video", dest="segments", action=_segment_action("video"), help="Video file path or URL")
    send_group.add_argument("-r", "--reply", dest="segments", action=_segment_action("reply"), help="Reply to a message id")
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

    watch = subparsers.add_parser("watch", help="Watch QQ incoming messages and print JSON")
    watch.add_argument("--from-group", dest="from_group", help="Only include messages from this group id")
    watch.add_argument("--from-user", dest="from_user", help="Only include messages from this user id")

    return parser


def _build_message_segments(args: argparse.Namespace) -> List[object]:
    segments = getattr(args, "segments", []) or []
    ordered = sorted(segments, key=lambda x: x[0])
    parts: List[object] = []
    for _, seg_type, value in ordered:
        if seg_type == "reply":
            parts.append(ReplyMessage(value))
        elif seg_type == "text":
            parts.append(TextMessage(value))
        elif seg_type == "image":
            parts.append(ImageMessage(value))
        elif seg_type == "video":
            parts.append(VideoMessage(value))
        elif seg_type == "file":
            parts.append(FileMessage(value))
    return parts


def _build_forward_nodes(args: argparse.Namespace, parts: List[object]) -> List[ForwardNode]:
    user_id = os.getenv("NAPCAT_FORWARD_USER_ID", "")
    nickname = os.getenv("NAPCAT_FORWARD_NICKNAME", "メイド")
    return [ForwardNode(user_id, nickname, [part]) for part in parts]


def _serialize_parts(parts: List[object]) -> List[dict]:
    return [part.as_dict() if hasattr(part, "as_dict") else part for part in parts]


def _print_response(response: dict) -> None:
    sys.stdout.write(json.dumps(response, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _run_send_group(args: argparse.Namespace) -> int:
    parts = _build_message_segments(args)
    if not parts:
        sys.stderr.write("No message content supplied; add --text/--image/--file/--video/--reply\n")
        return 2

    is_forward = args.forward or args.type == "forward"
    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    try:
        if is_forward:
            nodes = _build_forward_nodes(args, parts)
            response = asyncio.run(send_group_forward_message(client, args.group_id, nodes))
        else:
            response = asyncio.run(send_group_message(client, args.group_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


def _run_send_private(args: argparse.Namespace) -> int:
    parts = _build_message_segments(args)
    if not parts:
        sys.stderr.write("No message content supplied; add --text/--image/--file/--video/--reply\n")
        return 2

    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    try:
        response = asyncio.run(send_private_message(client, args.user_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


async def _watch_loop(url: str, from_group: Optional[str], from_user: Optional[str]) -> None:
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
                    sys.stdout.write(json.dumps(event, ensure_ascii=False, indent=2))
                    sys.stdout.write("\n")
                    sys.stdout.flush()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logging.warning("Watch loop error %s, reconnecting in 3s", exc)
            await asyncio.sleep(3)


def _run_watch(args: argparse.Namespace) -> int:
    url = os.getenv("NAPCAT_URL")
    if not url:
        sys.stderr.write("NAPCAT_URL is required for watch\n")
        return 2
    try:
        asyncio.run(_watch_loop(url, args.from_group, args.from_user))
    except KeyboardInterrupt:
        logging.info("watch stopped by user")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)

    if args.command == "send":
        return _run_send_private(args)
    if args.command == "send-group":
        return _run_send_group(args)
    if args.command == "watch":
        return _run_watch(args)

    parser.error(f"Unknown command {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
