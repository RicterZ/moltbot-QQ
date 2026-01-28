# syntax=docker/dockerfile:1

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml poetry.lock README.md /app/
COPY src /app/src

RUN pip install --no-cache-dir .

# Default command runs the daemon; override with other nap-msg commands if needed.
CMD ["nap-msg-daemon"]
