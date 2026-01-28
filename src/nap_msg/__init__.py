"""
CLI relay between moltbot and a Napcat WebSocket backend.
"""

from .client import NapcatRelayClient, send_group_forward_message, send_group_message, send_private_message
from .messages import (
    Command,
    CommandType,
    FileMessage,
    ForwardNode,
    ImageMessage,
    ReplyMessage,
    TextMessage,
    VideoMessage,
)

__all__ = [
    "NapcatRelayClient",
    "send_group_message",
    "send_group_forward_message",
    "send_private_message",
    "Command",
    "CommandType",
    "FileMessage",
    "ForwardNode",
    "ImageMessage",
    "ReplyMessage",
    "TextMessage",
    "VideoMessage",
]
