#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec env PYTHONPATH=/tmp/mcp-pylib python3 "$DIR/sampling.py"
