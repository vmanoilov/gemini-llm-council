#!/bin/bash

# check-env.sh: SessionStart hook for gemini-llm-council

# Check for API Key
if [ -z "$OPENROUTER_API_KEY" ] && [ -z "$GEMINI_CLI_OPENROUTER_API_KEY" ]; then
  echo '{"systemMessage": "🏛️  **Council Warning**: `OPENROUTER_API_KEY` is not set. Council features will be unavailable.", "suppressOutput": false}'
  exit 0
fi

# Check for config (silently)
# We use a simple check for the config file since we can't easily call the MCP tool here without a session
if [ ! -f ".gemini/llm-council.json" ] && [ ! -f "$HOME/.gemini/extensions/gemini-llm-council/config.json" ]; then
  echo '{"systemMessage": "🏛️  **Council Notice**: No configuration found. Run `/council:setup` to initialize.", "suppressOutput": false}'
  exit 0
fi
