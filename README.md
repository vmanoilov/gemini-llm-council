# Gemini LLM Council Extension

Consult multiple top-tier LLMs simultaneously with automated peer review and synthesis. Leverage the "Wisdom of the Crowd" to get high-confidence answers for complex architectural and debugging tasks.

Inspired by Andrej Karpathy's [llm-council](https://github.com/karpathy/llm-council).

## ✨ Advanced Features

-   **Autonomous Investigator**: New `/council:investigate` command that uses a specialized subagent to autonomously explore your codebase and gather evidence before deliberating.
-   **Hierarchical Config**: Save your council settings **Globally** (for all projects) or **Project-specifically** (checked into your repo).
-   **Specialized Personas**: Run targeted reviews using built-in audit personas (e.g., `security`, `performance`).
-   **Automatic IQ**: The council automatically detects if your query requires a specific persona and applies it to guide the review phase.
-   **Customizable**: Define your own personas in `~/.gemini/extensions/gemini-llm-council/personas.json`.
-   **Ambient Grounding**: System hooks automatically inject core project metadata (README, package.json) into council consultations.
-   **Deep Audit Trail**: Offload massive raw deliberations to MCP Resources. Accessible via `council://` URIs provided in the summary report.

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
    ```bash
    gemini extensions config gemini-llm-council "OpenRouter API Key"
    ```

3.  **Build the extension**:
    ```bash
    npm install
    npm run build
    ```

4.  **Configure Council Members**:
    ```bash
    /council:setup
    ```
    *Choose between **Global** (All Projects) or **Project** (Current Folder) scope.*

## Commands

| Command | Description |
| :--- | :--- |
| `/council:setup` | Select models, reasoning depth, and configuration scope. |
| `/council:ask <query>` | One-shot consultation with automated project grounding and persona detection. |
| `/council:investigate <issue>` | **Autonomous**: Subagent handles the file-reading and deliberation loop. |
| `/council:persona <name> <query>` | Consult using a specific persona (e.g., `security`, `performance`, or your custom ones). |
| `/council:status` | Show active members, reasoning effort, and active configuration scope. |

## Usage Examples

### Autonomous Debugging
```
/council:investigate "The database connection keeps timing out in production environments."
```
*The council investigator will autonomously find your config files, logs, and connection logic to provide a verified fix.*

### Security Audit (Automatic or Explicit)
```
/council:ask "Audit the new user registration flow for potential injection flaws."
```
*The Chairman will automatically detect the "Security" domain and load the appropriate persona.*

### Global vs Project Config
- **Global**: Stored in `~/.gemini/extensions/gemini-llm-council/config.json`.
- **Project**: Stored in `.gemini/llm-council.json`. (Project config overrides global).

## Architecture

*   **Autonomous Orchestration**: Uses Gemini CLI **Subagents** to isolate the heavy lifting of multi-file investigations.
-   **Intelligent Grounding**: Uses **BeforeTool Hooks** to automatically provide context about your tech stack.
-   **Clean UI**: Moves raw multi-model critiques to **MCP Resources**, keeping your main chat readable.

## Inspiration

This project was inspired by Andrej Karpathy's [LLM council](https://github.com/karpathy/llm-council) project, as shared in his [Twitter (X) post](https://x.com/karpathy/status/1992381094667411768).

## License

MIT