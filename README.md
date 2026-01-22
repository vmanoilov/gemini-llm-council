# Gemini LLM Council Extension

Consult multiple top-tier LLMs simultaneously with automated peer review and synthesis. Leverage the "Wisdom of the Crowd" to get high-confidence answers for complex architectural and debugging tasks.

Inspired by Andrej Karpathy's [llm-council](https://github.com/karpathy/llm-council).

## Prerequisites

- [Gemini CLI](https://github.com/theerud/gemini-cli) installed.
- An **OpenRouter API Key**.

## Setup

1.  **Link the extension**:
    ```bash
    gemini extensions link .
    ```

2.  **Configure API Key**:
    Use the Gemini CLI to set your OpenRouter API key securely. 
    *(Note: This requires Gemini CLI v0.24.0-preview or later)*
    ```bash
    gemini extensions config gemini-llm-council "OpenRouter API Key"
    ```

    **Headless / CI Environments**: If the system keychain is unavailable, you can set the API key directly in your shell. 
    
    > [!CAUTION]
    > **Security Warning**: Using the `GEMINI_CLI_` prefix whitelists the variable from redaction.
    > 1. **Leakage**: Secrets will appear in plaintext in logs (`~/.gemini/logs/`) and error traces.
    > 2. **Lack of Isolation**: These variables are global and visible to *all* installed Gemini extensions.
    > 3. **Display**: These secrets may be displayed in plaintext during verbose output or screen sharing.
    > 
    > Only use this for ephemeral, headless environments (like CI/CD). For local development, always prefer the keychain-backed method.

    ```bash
    export GEMINI_CLI_OPENROUTER_API_KEY=sk-or-...
    ```

3.  **Build the extension**:
    ```bash
    npm install
    npm run build
    ```

4.  **Configure Council Members**:
    Run the setup command in your project workspace.
    ```bash
    /council:setup
    ```
    > **Note**: For the best setup experience (interactive selection), this extension supports the `ask_user` tool. This tool is inspired by Claude Code's AskUserQuestion and is available in the [develop branch of this Gemini CLI fork](https://github.com/theerud/gemini-cli/tree/develop) now. It will also be landing in the official Gemini CLI [soon](https://github.com/google-gemini/gemini-cli/issues/16621). If not available, setup will fall back to a text-based workflow.

## Commands

| Command | Description |
| :--- | :--- |
| `/council:setup` | Select and save your preferred models for the current workspace. |
| `/council:ask` | Consult the Council. Supports `--json` or `--markdown` flags. |
| `/council:status` | Show active council members and the configuration file path. |

## Usage

### Workspace Isolation
Configurations are project-specific and stored in `.gemini/llm-council.json` within your project root. This allows you to have a "Fast & Cheap" council for one project and a "God Mode" council for another.

### Convening the Council
You can explicitly invoke the council or specify a preferred output format:
```
/council:ask "What is the best way to implement a singleton in TypeScript?"
/council:ask --json "Compare these three sorting algorithms."
```

### Proactive Intelligence
The LLM Council functions as an on-demand "Brain Trust." While you can use slash commands for direct control, the Gemini Agent is also trained to recognize high-stakes scenarios—such as intricate system designs or difficult debugging— and will proactively offer to engage the Council for a multi-perspective analysis.

## Architecture

The extension is built as a specialized Agent Skill, providing a seamless and token-efficient integration.

*   **Efficiency by Design**: The Council's heavy reasoning protocols are only loaded when active, keeping your primary conversation context clean and responsive.
*   **Drafting Phase**: Selected models provide independent, diverse solutions to your query.
*   **Peer Review Phase**: Models critique each other's anonymized drafts to identify edge cases and vulnerabilities.
*   **Synthesis**: The Chairman (your primary agent) synthesizes the collective findings into a single, authoritative consensus, prioritizing the most robust and secure path forward.

## Inspiration

This project was inspired by Andrej Karpathy's [LLM council](https://github.com/karpathy/llm-council) project, as shared in his [Twitter (X) post](https://x.com/karpathy/status/1992381094667411768).

## License

MIT