import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as dotenv from "dotenv";
import { AVAILABLE_MODELS, getCouncilConfig, getCouncilStatus, saveCouncilConfig } from "./config.js";
import { DRAFTING_PROMPT, REVIEW_PROMPT, SYNTHESIS_PROMPT } from "./prompts.js";

dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.GEMINI_CLI_OPENROUTER_API_KEY;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

interface LLMResponse {
  content: string;
  reasoning?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_discount?: number;
  };
  error?: string;
}

interface CouncilMemberResponse extends LLMResponse {
  model: string;
}

interface CouncilOutput {
  drafts: CouncilMemberResponse[];
  reviews: CouncilMemberResponse[];
  synthesis_instructions: string;
  total_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

if (!OPENROUTER_API_KEY) {
  console.warn("Warning: OPENROUTER_API_KEY is not set in .env file.");
}

const server = new McpServer({
  name: "gemini-llm-council",
  version: "0.2.0",
});

async function callLLM(model: string, messages: any[], reasoningEffort: string = "none"): Promise<LLMResponse> {
  try {
    const isAnthropic = model.startsWith("anthropic/");
    
    // Inject cache_control for Anthropic if messages are large
    const processedMessages = messages.map((msg, idx) => {
      if (isAnthropic && msg.content && msg.content.length > 2000 && idx < messages.length - 1) {
        return {
          ...msg,
          cache_control: { type: "ephemeral" }
        };
      }
      return msg;
    });

    const payload: any = {
      model: model,
      messages: processedMessages,
      include_usage: true,
    };

    if (reasoningEffort !== "none") {
      payload.reasoning = { effort: reasoningEffort };
    }

    const response = await axios.post(
      OPENROUTER_URL,
      payload,
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://geminicli.com", 
          "X-Title": "Gemini CLI Council Extension",
        },
      }
    );
    
    const data = response.data as any;
    const choice = data.choices[0];
    const message = choice.message;
    
    // Handle reasoning
    let reasoning = "";
    if (message.reasoning) {
      reasoning = message.reasoning;
    } else if (message.reasoning_details) {
      // Some models return reasoning_details array
      reasoning = Array.isArray(message.reasoning_details) 
        ? message.reasoning_details.map((d: any) => d.text || "").join("\n")
        : JSON.stringify(message.reasoning_details);
    }

    return {
      content: message.content || "",
      reasoning: reasoning || undefined,
      usage: data.usage,
    };
  } catch (error: any) {
    let errorMessage = error.message;
    if ((axios as any).isAxiosError?.(error) || error.isAxiosError) {
      if (error.response) {
        const status = error.response.status;
        const body = error.response.data;
        if (status === 401) {
          errorMessage = "401 Unauthorized (Invalid API Key)";
        } else if (status === 402) {
          errorMessage = "402 Payment Required (Insufficient Credits)";
        } else if (status === 429) {
          errorMessage = "429 Too Many Requests (Rate Limit Exceeded)";
        } else if (body && body.error && body.error.message) {
          errorMessage = body.error.message;
        } else {
          errorMessage = `${status} ${error.response.statusText}`;
        }
      }
    }
    return {
      content: "",
      error: errorMessage,
    };
  }
}

server.tool(
  "list_available_models",
  "List all available model IDs and names supported by the council via OpenRouter.",
  {},
  async () => {
    const formattedModels = AVAILABLE_MODELS.map(m => {
      const features = [];
      if (m.features.reasoning) features.push("Reasoning");
      if (m.features.caching) features.push("Caching");
      const featureStr = features.length > 0 ? ` (Features: ${features.join(", ")})` : "";
      return `* **${m.name}** (\`${m.id}\`)${featureStr}`;
    }).join("\n");

    return {
      content: [{ type: "text", text: `### Available Models\n\n${formattedModels}` }],
    };
  }
);

server.tool(
  "consult_council",
  "Engage the LLM Council to answer a query using the 2-phase Drafting and Peer Review process.",
  {
    query: z.string().describe("The user's query to the council."),
    context: z.string().optional().describe("Additional context (file contents, search results) gathered by the Chairman."),
    models: z.array(z.string()).optional().describe("Specific models to consult. If omitted, uses defaults."),
    reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional().describe("The effort level for reasoning (thinking tokens)."),
  },
  async ({ query, context, models, reasoning_effort }) => {
    // 1. Check API Key
    if (!OPENROUTER_API_KEY) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          error: "MISSING_KEY",
          message: "OpenRouter API Key is missing. Please check your .env file."
        }) }],
        isError: true,
      };
    }

    let selectedModels = models;
    let effort = reasoning_effort;

    // 2. Resolve Config
    const config = await getCouncilConfig();
    if (!selectedModels || selectedModels.length === 0) {
      selectedModels = config.default_models;
    }
    if (!effort) {
      effort = config.default_reasoning_effort || "none";
    }

    // 3. Strict No-Config Error
    if (!selectedModels || selectedModels.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          error: "NO_CONFIG",
          message: "Council members are not configured. Please run /council:setup."
        }) }],
        isError: true,
      };
    }

    // Phase 1: Drafting
    // Place context at the beginning to stabilize prefix for caching
    const draftingMessages = [
      { role: "system", content: DRAFTING_PROMPT },
      { role: "user", content: `Context:\n${context || "None"}\n\nQuery: ${query}` },
    ];

    const draftPromises = selectedModels.map(async (model) => {
      const response = await callLLM(model, draftingMessages, effort);
      return { model, ...response };
    });

    const drafts = await Promise.all(draftPromises);

    // Prepare Review Packet (Anonymized)
    let reviewPacket = "Here are the answers from other council members:\n\n";
    drafts.forEach((draft, index) => {
      reviewPacket += `--- Answer ${index + 1} ---\n${draft.content || "[Error: " + draft.error + "]"}\n\n`;
    });

    // Phase 2: Peer Review
    const reviewPromises = selectedModels.map(async (model) => {
      const reviewMessages = [
        { role: "system", content: REVIEW_PROMPT },
        { role: "user", content: `Context:\n${context || "None"}\n\nQuery: ${query}\n\n${reviewPacket}` },
      ];
      const response = await callLLM(model, reviewMessages, effort);
      return { model, ...response };
    });

    const reviews = await Promise.all(reviewPromises);

    // Format Output
    const output = {
      drafts,
      reviews,
      synthesis_instructions: SYNTHESIS_PROMPT,
      total_usage: {
        prompt_tokens: [...drafts, ...reviews].reduce((acc, r) => acc + (r.usage?.prompt_tokens || 0), 0),
        completion_tokens: [...drafts, ...reviews].reduce((acc, r) => acc + (r.usage?.completion_tokens || 0), 0),
        total_tokens: [...drafts, ...reviews].reduce((acc, r) => acc + (r.usage?.total_tokens || 0), 0),
      }
    };

    const report = generateMarkdownReport(output);

    return {
      content: [{ type: "text", text: report }],
    };
  }
);

/**
 * Generates a structured Markdown report for the TUI and Chairman synthesis.
 */
function generateMarkdownReport(output: CouncilOutput): string {
  const { drafts, reviews, total_usage, synthesis_instructions } = output;
  
  let md = "# 🏛️ Council Deliberation\n\n";

  // Salience: Put instructions at the top for the Chairman
  md += "## 🛠️ Synthesis Instructions\n";
  md += `${synthesis_instructions}\n\n`;
  
  // Member Summary Table
  md += "### 👥 Member Status\n\n";
  md += "| Member | Model | Drafting | Review | Tokens |\n";
  md += "| :--- | :--- | :---: | :---: | :---: |\n";
  
  drafts.forEach((d, i) => {
    const r = reviews?.[i];
    const dStatus = d.error ? "❌" : "✅";
    const rStatus = r ? (r.error ? "❌" : "✅") : "-";
    const dTokens = (d.usage?.total_tokens || 0) + (r?.usage?.total_tokens || 0);
    md += `| ${i + 1} | \`${d.model}\` | ${dStatus} | ${rStatus} | ${dTokens.toLocaleString()} |\n`;
  });
  md += "\n";

  // Phase 1: Drafting
  md += "## ✍️ Phase 1: Drafting\n\n";
  drafts.forEach((d, i) => {
    md += `### Member ${i + 1} (\`${d.model}\`)\n`;
    if (d.error) {
      md += `> ⚠️ **Error**: ${d.error}\n\n`;
    } else {
      if (d.reasoning) {
        md += `#### 🧠 Reasoning Path\n> ${d.reasoning.replace(/\n/g, "\n> ")}\n\n`;
      }
      md += "#### 📝 Draft Answer\n";
      md += "```markdown\n";
      md += `${d.content}\n`;
      md += "```\n\n";
    }
  });

  // Phase 2: Peer Review
  md += "## 🔍 Phase 2: Peer Review\n\n";
  if (reviews && reviews.length > 0) {
    reviews.forEach((r, i) => {
      if (!r) return; // Null guard to prevent crash
      
      md += `### Review ${i + 1} (Critique of Draft ${i + 1}) (\`${r.model}\`)\n`;
      if (r.error) {
        md += `> ⚠️ **Error**: ${r.error}\n\n`;
      } else {
        if (r.reasoning) {
          md += `#### 🧠 Reasoning Path\n> ${r.reasoning.replace(/\n/g, "\n> ")}\n\n`;
        }
        md += "#### 🧐 Peer Critique\n";
        md += "```markdown\n";
        md += `${r.content}\n`;
        md += "```\n\n";
      }
    });
  } else {
    md += "_No reviews were generated._\n\n";
  }

  md += "---\n";
  md += "### 📊 Metadata Summary\n";
  md += `* **Total Tokens**: ${total_usage.total_tokens.toLocaleString()}\n`;
  md += `* **Prompt Tokens**: ${total_usage.prompt_tokens.toLocaleString()}\n`;
  md += `* **Completion Tokens**: ${total_usage.completion_tokens.toLocaleString()}\n`;
  
  return md;
}

server.tool(
  "save_council_config",
  "Save the default list of model IDs for the council to a configuration file.",
  {
    models: z.array(z.string()).describe("The list of models to save as defaults."),
    reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional().describe("The default effort level for reasoning."),
  },
  async ({ models, reasoning_effort }) => {
    await saveCouncilConfig(models, reasoning_effort);
    let message = `Configuration saved. Default models: ${models.join(", ")}. Default reasoning: ${reasoning_effort || "none"}`;
    if (models.length > 5) {
      message += "\n\nWarning: You have selected more than 5 models. This may result in higher latency and increased API costs.";
    }
    return {
      content: [{ type: "text", text: message }],
    };
  }
);

server.tool(
  "get_council_status",
  "Get the current council configuration status, including active models and the file path of the config file.",
  {},
  async () => {
    const status = await getCouncilStatus();
    let message = `### Council Status: ${status.exists ? "Active" : "Not Configured"}\n`;
    message += `* **Config File**: \`${status.configPath}\`\n`;
    if (status.exists) {
      message += `* **Reasoning Effort**: ${status.reasoning_effort}\n`;
      message += `* **Active Members**:\n`;
      message += status.models.map(m => `    * \`${m}\``).join("\n");
    } else {
      message += "\nRun `/council:setup` to configure your council.";
    }
    
    return {
      content: [{ type: "text", text: message }],
    };
  }
);

server.tool(
  "get_council_config",
  "Get the current council configuration (list of active models).",
  {},
  async () => {
    const config = await getCouncilConfig();
    let md = "### ⚙️ Council Configuration\n";
    md += `* **Default Models**: ${config.default_models.map(m => `\`${m}\``).join(", ")}\n`;
    md += `* **Reasoning Effort**: \`${config.default_reasoning_effort || "none"}\`\n`;
    return {
      content: [{ type: "text", text: md }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini LLM Council MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});