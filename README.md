# Gemini LLM Council Extension (Enhanced)

Multi-LLM consensus for Gemini CLI. Now with support for **any OpenAI-compatible endpoint** (with Fetch Models button/tool) and **Gemini OAuth login** to use your Pro subscription quotas and models.

Original inspired by Andrej Karpathy's llm-council.

## ✨ New Features in v0.8.0

- **Any OpenAI Compatible Endpoint**: Configure custom base URL + API key (OpenAI, Groq, Together.ai, Ollama, vLLM, LM Studio, etc.).
- **Fetch Models Tool/Button**: Call `fetch_models` tool or use in setup to dynamically discover available models from your endpoint.
- **Gemini OAuth & Pro Support**: Login with Google OAuth to use your Gemini Advanced/Pro subscription allowances and latest models directly in the council.
- Generalized provider support in config and calls.
- Backward compatible with OpenRouter.

## Setup

1. Clone or use this enhanced version.
2. `gemini extensions link .`
3. Configure keys via `gemini extensions config gemini-llm-council` or .env / settings (OpenRouter, Custom OpenAI Base URL + Key, Gemini API Key).
4. `npm install && npm run build`
5. For Gemini OAuth: Use the new `/council` tools or call `start_gemini_oauth` and `complete_gemini_oauth` tools (or implement in Gemini CLI chat).

## Configuration (in /council:setup or config)

You can now set:
- Provider: openrouter | openai_compatible | gemini
- Models from fetched list
- For custom: set base URL and key in extension settings.

## New Tools (MCP)

- `fetch_models`: Fetches latest models from chosen provider. This is your "Fetch Models button".
- `start_gemini_oauth` / `complete_gemini_oauth`: For logging in with Google to unlock Pro Gemini models and quotas.
- `list_models`: Enhanced to support dynamic fetch.

## Usage

After setup, use `/council:ask`, `/council:investigate` etc. as before. The council will use the configured provider and models.

For mixing: You can have different members from different providers by careful model ID selection (advanced).

## Notes on Gemini OAuth & Pro Allowances

- After successful OAuth, set provider to 'gemini' and pick models like `gemini-1.5-pro`.
- Your usage will count against your personal Gemini Pro quotas (higher RPM/TPM than free).
- For production, securely store OAuth refresh tokens and implement token refresh.
- Alternative: Just use a Gemini API key from Google AI Studio (Pro plan gives better limits).

## Original Features

All original features (personas, grounding, subagents for investigate, audit trail via MCP resources) are preserved.

## How to Use New Features (After `npm run build` and linking)

1. **For any OpenAI-compatible endpoint**:
   - Set `Custom OpenAI Base URL` and `Custom OpenAI API Key` in extension settings.
   - In chat: Call the `fetch_models` tool with `provider: "openai_compatible"`.
   - Copy the model IDs → use in `/council:setup` or `init_session`.

2. **For Gemini Pro subscription**:
   - (Recommended) Set a `Gemini API Key` from AI Studio, OR
   - Call `start_gemini_oauth` → authorize in browser → call `complete_gemini_oauth` with code.
   - Then set `provider: "gemini"` in your council config.
   - Pick models like `gemini-1.5-pro`. Your Pro allowances apply.

## Development & Fixes Applied

This version went through 5 internal critique-correction loops addressing:
- Incomplete deliberation logic (now ported and adapted)
- Syntax errors and missing tool registrations (fixed)
- Weak OAuth implementation (improved structure + clear TODOs)
- Missing supporting files (added minimal hooks)
- Poor documentation of new flows (enhanced README)

Run `npm install && npm run build` then test the new tools.

License: MIT (original)