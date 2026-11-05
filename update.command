#!/bin/bash
# Updates Posse to the latest version, then starts it. Your bots, chats and settings are kept.
exec /bin/bash "$(dirname "$0")/start.command" --update
