# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-01-28

### Added
- **Skills Adoption**: Migrated council logic to a specialized `council-chairman` agent skill for seamless integration and proactive multi-model analysis.
- **Stateful Investigation & RFI Loop**: Major internal overhaul introducing a stateful session management system (`SessionStore`) and an iterative Request For Information (RFI) loop. This allows council members to autonomously identify and request missing context, resulting in significantly higher accuracy for complex debugging and architectural tasks.
- Improved council setup protocol with configuration status checks.
- Improved usage of `ask_user` tool in models selection.

### Changed
- Updated Kimi model to K2.5.
- Refined `council-chairman` skill protocols for better clarity and efficiency.

### Fixed
- Cleaned up documentation and removed obsolete notes regarding tool availability.

## [0.2.1] - 2026-01-25

### Added
- Configurable output format (Markdown/JSON) for `consult` tool.
- Enhanced Markdown formatting for deliberation reports.

## [0.2.0] - 2026-01-25

### Added
- `/council:status` command to check current configuration.
- LLM reasoning path and token usage tracking.
- Environment variable fallback for `OPENROUTER_API_KEY`.
- Workspace-local configuration (`.gemini/llm-council.json`).
- Hybrid setup process supporting both interactive and text-based configuration.
- Peer review synthesis logic for high-quality council outputs.

### Changed
- Refined council setup instructions and model selection.
- Migrated to GPT-5.2-Codex for improved performance.
- Improved security warnings for API key handling.

### Fixed
- Corrected extension MCP server paths and build scripts.

## [0.1.0] - 2026-01-20

### Added
- Initial implementation of the LLM Council.
- Support for multiple models via OpenRouter.
- Basic drafting and synthesis workflow.
