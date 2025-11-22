#!/bin/bash
# Index the current project when Claude Code session starts

# Read the JSON payload from stdin
read -r payload

# Extract the cwd from the payload
cwd=$(echo "$payload" | python3 -c "import sys, json; print(json.load(sys.stdin).get('cwd', ''))")

# If no cwd, use current directory
if [ -z "$cwd" ]; then
    cwd=$(pwd)
fi

# Run osgrep index in the background
cd "$cwd" 2>/dev/null || exit 0
osgrep index > /tmp/osgrep-index.log 2>&1 &

# Output hook response
echo '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "osgrep index has been started in the background. Use the osgrep skill for semantic code search."}}'
exit 0



