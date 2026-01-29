import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as dotenv from "dotenv";
import { AVAILABLE_MODELS, getCouncilConfig, getCouncilStatus, saveCouncilConfig } from "./config.js";
import { DRAFTING_PROMPT, REVIEW_PROMPT, SYNTHESIS_PROMPT } from "./prompts.js";
import { sessionStore, CouncilSession, CouncilMemberResponse, SessionStatus } from "./sessions.js";

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

interface CouncilOutput {
  drafts: CouncilMemberResponse[];
  reviews: CouncilMemberResponse[];
  synthesis_instructions: string;
  total_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  session_id: string;
}

// In-memory store for raw deliberations to be exposed as MCP resources
const deliberationsStore = new Map<string, CouncilOutput>();

function parseRFIs(content: string): string[] {
  const rfiRegex = /<context_request>(.*?)<\/context_request>/g;
  const matches = [...content.matchAll(rfiRegex)];
  return matches.map(m => m[1].trim());
}

if (!OPENROUTER_API_KEY) {
  console.warn("Warning: OPENROUTER_API_KEY is not set in .env file.");
}

const server = new McpServer({
  name: "gemini-llm-council",
  version: "0.3.0",
});

// Register Resource: Raw Deliberations
server.resource(
  "deliberation",
  "council://sessions/[id]/raw-deliberation",
  async (uri) => {
    const match = uri.toString().match(/^council:\/\/sessions\/(.*?)\/raw-deliberation$/);
    if (!match) throw new Error("Invalid resource URI");
    const sessionId = match[1];
    const deliberation = deliberationsStore.get(sessionId);
    if (!deliberation) throw new Error("Deliberation not found");

    return {
      contents: [{
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(deliberation, null, 2)
      }]
    };
  }
);

// Register Persona Prompts
const BUILTIN_PERSONAS: Record<string, string> = {
  "security": "Act as a paranoid security researcher. Focus on input validation, RCE, and secrets.",
  "performance": "Act as a high-performance computing expert. Focus on Big O, concurrency, and I/O bottlenecks."
};

server.prompt(
  "persona",
  { name: z.string().describe("Name of the persona (security, performance, or custom ones)") },
  async ({ name }) => {
    let instructions = BUILTIN_PERSONAS[name];

    // Try to load custom personas from the global config directory
    try {
      const { GLOBAL_CONFIG_DIR } = await import("./config.js");
      const customPersonasPath = Buffer.from(require("node:path").join(GLOBAL_CONFIG_DIR, "personas.json")).toString();
      const customData = await require("node:fs/promises").readFile(customPersonasPath, "utf-8");
      const customPersonas = JSON.parse(customData);
      if (customPersonas[name]) {
        instructions = customPersonas[name];
      }
    } catch (e) {
      // Ignore if file doesn't exist or is invalid
    }

    if (!instructions) {
      instructions = "Act as an expert reviewer.";
    }

    return {
      description: `Instructions for the ${name} persona`,
      messages: [{
        role: "user",
        content: { type: "text", text: instructions }
      }]
    };
  }
);

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
  "list_models",
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

async function initSessionLogic(query: string, context?: string, models?: string[], reasoning_effort?: string): Promise<CouncilSession | { error: string }> {
  let selectedModels = models;
  let effort = reasoning_effort;

  const config = await getCouncilConfig();
  if (!selectedModels || selectedModels.length === 0) {
    selectedModels = config.default_models;
  }
  if (!effort) {
    effort = config.default_reasoning_effort || "none";
  }

  if (!selectedModels || selectedModels.length === 0) {
    return { error: "No models configured. Run /council:setup first." };
  }

  const session = sessionStore.createSession(process.cwd(), query, selectedModels, effort as any);
  if (context) {
    session.sharedContext = context;
  }
  return session;
}

async function runDeliberationLogic(session_id: string, force: boolean): Promise<{ output: CouncilOutput; report: string } | { rfi: any } | { error: string }> {
  const session = sessionStore.getSession(process.cwd(), session_id);
  if (!session) {
    return { error: "Session not found." };
  }

  if (!OPENROUTER_API_KEY) {
    return { error: "OPENROUTER_API_KEY is not set." };
  }

  // Phase 1: Drafting
  session.status = "DRAFTING";

  const draftPromises = session.models.map(async (model) => {
    const targeted = session.targetedContext[model] || [];

    let contextStr = "=== SHARED CONTEXT ===\n";
    contextStr += session.sharedContext || "No shared context provided.\n";

    if (targeted.length > 0) {
      contextStr += "\n=== TARGETED CONTEXT (Only you can see this) ===\n";
      contextStr += targeted.join("\n\n");
    }

    const draftingMessages = [
      { role: "system", content: DRAFTING_PROMPT },
      { role: "user", content: `${contextStr}\n\n=== USER QUERY ===\n${session.query}` },
    ];
    const response = await callLLM(model, draftingMessages, session.reasoningEffort);
    return { model, ...response };
  });

  const drafts = await Promise.all(draftPromises);
  session.drafts = drafts;

  // Check for RFIs
  const allRFIs: string[] = [];
  drafts.forEach(d => {
    if (d.content) {
      const rfis = parseRFIs(d.content);
      allRFIs.push(...rfis);
    }
  });

  // Filter RFIs that were already requested in this session to avoid infinite loops
  const uniqueRFIs = Array.from(new Set(allRFIs));

  if (uniqueRFIs.length > 0 && !force && session.rfiRoundCount < 2) {
    session.rfiRoundCount++;
    session.status = "STALLED_RFI";
    return {
      rfi: {
        status: "STALLED_RFI",
        requests: uniqueRFIs,
        message: "The council requires more information to proceed."
      }
    };
  }

  // Phase 2: Peer Review & Synthesis
  session.status = "SYNTHESIZING";

  const allTargeted = Object.values(session.targetedContext).flat();
  const groundTruth = (session.sharedContext || "") + (allTargeted.length > 0 ? "\n\nConsolidated Context:\n" + allTargeted.join("\n\n") : "");

  const reviewPacket = "Here are the answers from other council members:\n\n" +
    drafts.map((d, i) => `--- Answer ${i + 1} ---\n${d.content || "[Error: " + d.error + "]"}`).join("\n\n");

  const reviewPromises = session.models.map(async (model) => {
    const reviewMessages = [
      { role: "system", content: REVIEW_PROMPT },
      { role: "user", content: `Ground Truth Context:\n${groundTruth}\n\nQuery: ${session.query}\n\n${reviewPacket}` },
    ];
    const response = await callLLM(model, reviewMessages, session.reasoningEffort);
    return { model, ...response };
  });

  const reviews = await Promise.all(reviewPromises);
  session.reviews = reviews;
  session.status = "COMPLETED";

  const output: CouncilOutput = {
    drafts,
    reviews,
    synthesis_instructions: SYNTHESIS_PROMPT,
    total_usage: {
      prompt_tokens: [...drafts, ...reviews].reduce((acc, r) => acc + (r.usage?.prompt_tokens || 0), 0),
      completion_tokens: [...drafts, ...reviews].reduce((acc, r) => acc + (r.usage?.completion_tokens || 0), 0),
      total_tokens: [...drafts, ...reviews].reduce((acc, r) => acc + (r.usage?.total_tokens || 0), 0),
    },
    session_id: session.id
  };

  // Store for resource access
  deliberationsStore.set(session.id, output);

  return { output, report: generateMarkdownReport(output) };
}

server.tool(
  "init_session",
  "Initialize a stateful council deliberation session.",
  {
    query: z.string().describe("The user's query to the council."),
    context: z.string().optional().describe("Initial shared context."),
    models: z.array(z.string()).optional().describe("Specific models to consult. If omitted, uses defaults."),
    reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional().describe("The effort level for reasoning."),
  },
  async ({ query, context, models, reasoning_effort }) => {
    const result = await initSessionLogic(query, context, models, reasoning_effort);
    if ("error" in result) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ session_id: result.id, status: result.status }) }],
    };
  }
);

server.tool(
  "add_context",
  "Provide additional context to a council session.",
  {
    session_id: z.string().describe("The session ID."),
    content: z.string().describe("The context content."),
    member_id: z.string().optional().default("all").describe("Target member index (1-based) or 'all' for shared context."),
  },
  async ({ session_id, content, member_id }) => {
    const session = sessionStore.getSession(process.cwd(), session_id);
    if (!session) {
      return { content: [{ type: "text", text: "Error: Session not found." }], isError: true };
    }

    if (member_id === "all") {
      session.sharedContext += (session.sharedContext ? "\n\n" : "") + content;
    } else {
      const idx = parseInt(member_id) - 1;
      if (isNaN(idx) || idx < 0 || idx >= session.models.length) {
        return { content: [{ type: "text", text: `Error: Invalid member_id '${member_id}'.` }], isError: true };
      }
      const model = session.models[idx];
      if (!session.targetedContext[model]) {
        session.targetedContext[model] = [];
      }
      session.targetedContext[model].push(content);
    }

    return { content: [{ type: "text", text: "Context added successfully." }] };
  }
);

server.tool(
  "investigate",
  "Run or resume the deliberation process for a council session.",
  {
    session_id: z.string().describe("The session ID."),
    force: z.boolean().optional().default(false).describe("Force synthesis even if RFIs are pending."),
    format: z.enum(["markdown", "json"]).optional().default("markdown").describe("The output format."),
  },
  async ({ session_id, force, format }) => {
    const result = await runDeliberationLogic(session_id, force);
    if ("error" in result) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }
    if ("rfi" in result) {
      return { content: [{ type: "text", text: JSON.stringify(result.rfi, null, 2) }] };
    }
    if (format === "json") {
      return { content: [{ type: "text", text: JSON.stringify(result.output, null, 2) }] };
    }
    return { content: [{ type: "text", text: result.report }] };
  }
);

server.tool(
  "consult",
  "Engage the LLM Council to answer a query using the 2-phase Drafting and Peer Review process.",
  {
    query: z.string().describe("The user's query to the council."),
    context: z.string().optional().describe("Additional context gathered by the Chairman."),
    models: z.array(z.string()).optional().describe("Specific models to consult. If omitted, uses defaults."),
    reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional().describe("The effort level for reasoning."),
    format: z.enum(["markdown", "json"]).optional().default("markdown").describe("The output format."),
  },
  async ({ query, context, models, reasoning_effort, format }) => {
    const initRes = await initSessionLogic(query, context, models, reasoning_effort);
    if ("error" in initRes) {
      return { content: [{ type: "text", text: initRes.error }], isError: true };
    }

    const delibRes = await runDeliberationLogic(initRes.id, true);
    if ("error" in delibRes) {
      return { content: [{ type: "text", text: delibRes.error }], isError: true };
    }
    if ("rfi" in delibRes) {
      return { content: [{ type: "text", text: JSON.stringify(delibRes.rfi, null, 2) }] };
    }

    if (format === "json") {
      return { content: [{ type: "text", text: JSON.stringify(delibRes.output, null, 2) }] };
    }
    return { content: [{ type: "text", text: delibRes.report }] };
  }
);

/**
 * Generates a structured Markdown report for the TUI and Chairman synthesis.
 */
function generateMarkdownReport(output: CouncilOutput): string {
  const { drafts, reviews, total_usage, synthesis_instructions, session_id } = output;

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

  md += `> 📄 **Full Audit Trail**: Raw deliberations are available at \`council://sessions/${session_id}/raw-deliberation\`\n\n`;

  md += "---\n";
  md += "### 📊 Metadata Summary\n";
  md += `* **Total Tokens**: ${total_usage.total_tokens.toLocaleString()}\n`;
  md += `* **Prompt Tokens**: ${total_usage.prompt_tokens.toLocaleString()}\n`;
  md += `* **Completion Tokens**: ${total_usage.completion_tokens.toLocaleString()}\n`;

  return md;
}

server.tool(
  "save_config",
  "Save the default list of model IDs for the council to a configuration file.",
  {
    models: z.array(z.string()).describe("The list of models to save as defaults."),
    reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional().describe("The default effort level for reasoning."),
    scope: z.enum(["project", "global"]).optional().default("project").describe("The scope to save the configuration to.")
  },
  async ({ models, reasoning_effort, scope }) => {
    await saveCouncilConfig(models, reasoning_effort, scope as any);
    let message = `Configuration saved to **${scope}** scope. Default models: ${models.join(", ")}. Default reasoning: ${reasoning_effort || "none"}`;
    if (models.length > 5) {
      message += "\n\nWarning: You have selected more than 5 models. This may result in higher latency and increased API costs.";
    }
    return {
      content: [{ type: "text", text: message }],
    };
  }
);

server.tool(
  "get_status",
  "Get the current council configuration status, including active models and the file path of the config file.",
  {},
  async () => {
    const status = await getCouncilStatus();
    let message = `### Council Status: ${status.exists ? "Active" : "Not Configured"}\n`;
    message += `* **Scope**: \`${status.scope}\`\n`;
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
  "get_config",
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
