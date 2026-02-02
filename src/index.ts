import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AVAILABLE_MODELS, getCouncilConfig, getCouncilStatus, saveCouncilConfig, GLOBAL_CONFIG_DIR } from "./config.js";
import { DRAFTING_PROMPT, REVIEW_PROMPT, SYNTHESIS_PROMPT } from "./prompts.js";
import { sessionStore, CouncilSession, CouncilMemberResponse, SessionStatus } from "./sessions.js";

dotenv.config();

// Safe __dirname for both CJS and ESM
const _dirname = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(require('node:url').fileURLToPath((global as any).import?.meta?.url || 'file:'));

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
  consensus_score: number;
  total_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  session_id: string;
  timestamp: number; // For cleanup
}

// In-memory store for raw deliberations to be exposed as MCP resources
const deliberationsStore = new Map<string, CouncilOutput>();

/**
 * Periodically cleans up old deliberations to prevent memory leaks.
 * Keeps records for 1 hour.
 */
function cleanupDeliberations() {
  const now = Date.now();
  const TTL = 60 * 60 * 1000; // 1 hour
  let count = 0;
  for (const [id, data] of deliberationsStore.entries()) {
    if (now - data.timestamp > TTL) {
      deliberationsStore.delete(id);
      count++;
    }
  }
  if (count > 0) {
    console.error(`[Council] Cleaned up ${count} expired deliberations from memory.`);
  }
}

function parseRFIs(content: string): string[] {
  // Matches <context_request>path</context_request> and variations with whitespace or markdown
  const rfiRegex = /<context_request>\s*([\s\S]*?)\s*<\/context_request>/gi;
  const matches = [...content.matchAll(rfiRegex)];
  return matches
    .map(m => m[1].trim())
    .filter(path => path.length > 0 && !path.includes('`')); // Filter out markdown artifacts
}

if (!OPENROUTER_API_KEY) {
  console.warn("Warning: OPENROUTER_API_KEY is not set in .env file.");
}

const server = new McpServer({
  name: "gemini-llm-council",
  version: "0.4.0",
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
    if (!deliberation) throw new Error("Deliberation not found or expired");

    return {
      contents: [{
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(deliberation, null, 2)
      }]
    };
  }
);

// Persona cache with mtime tracking
interface CachedPersona {
  content: string;
  mtime: number;
}
const personaCache = new Map<string, CachedPersona>();

async function getPersonaInstructions(name: string): Promise<string> {
  const BUILTIN_PERSONAS: Record<string, string> = {
    "security": "Act as a paranoid security researcher. Focus on input validation, RCE, and secrets.",
    "performance": "Act as a high-performance computing expert. Focus on Big O, concurrency, and I/O bottlenecks."
  };

  // 1. Try to load from the extension's prompts/ directory (v0.4.0+ WYSIWYG)
  const promptPath = path.join(_dirname, "..", "prompts", `${name}.md`);
  try {
    const stats = await fs.stat(promptPath);
    const cached = personaCache.get(promptPath);
    if (cached && cached.mtime === stats.mtimeMs) {
      return cached.content;
    }
    const content = await fs.readFile(promptPath, "utf-8");
    personaCache.set(promptPath, { content, mtime: stats.mtimeMs });
    return content;
  } catch (e) {
    // File not found, fall through
  }

  // 2. Try to load from custom personas.json in global config
  const customPersonasPath = path.join(GLOBAL_CONFIG_DIR, "personas.json");
  try {
    const stats = await fs.stat(customPersonasPath);
    const cacheKey = `json:${customPersonasPath}`;
    const cached = personaCache.get(cacheKey);

    let personasJson: Record<string, string>;
    if (cached && cached.mtime === stats.mtimeMs) {
      personasJson = JSON.parse(cached.content);
    } else {
      const data = await fs.readFile(customPersonasPath, "utf-8");
      personaCache.set(cacheKey, { content: data, mtime: stats.mtimeMs });
      personasJson = JSON.parse(data);
    }

    if (personasJson[name]) {
      return personasJson[name];
    }
  } catch (e) {
    // Ignore JSON errors or missing file
  }

  // 3. Built-in hardcoded fallbacks
  return BUILTIN_PERSONAS[name] || "Act as an expert reviewer.";
}

server.prompt(
  "persona",
  { name: z.string().describe("Name of the persona (security, performance, or custom ones)") },
  async ({ name }) => {
    const instructions = await getPersonaInstructions(name);
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

    // Inject cache_control for Anthropic if messages are large enough to benefit
    const processedMessages = messages.map((msg, idx) => {
      let contentLength = 0;
      if (typeof msg.content === 'string') {
        contentLength = msg.content.length;
      } else if (Array.isArray(msg.content)) {
        contentLength = msg.content.reduce((acc: number, block: any) => acc + (block.text?.length || 0), 0);
      }

      // Anthropic requires explicit cache_control tags.
      // We apply it to large messages that are part of the stable prefix (not the last message).
      if (isAnthropic && contentLength > 1024 && idx < messages.length - 1) {
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
        const body = error.response.data;
        if (body && body.error && body.error.message) {
          errorMessage = body.error.message;
        } else {
          errorMessage = `${error.response.status} ${error.response.statusText}`;
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
  cleanupDeliberations(); // Proactive cleanup

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

    // STABLE PREFIX: Same for both phases to maximize caching
    const stablePrefixMessages = [
      { role: "system", content: "You are a member of an expert LLM Council. Your goal is to provide a comprehensive, accurate, and insightful answer." },
      { role: "user", content: `=== SHARED CONTEXT ===\n${session.sharedContext || "No shared context provided."}\n\n=== USER QUERY ===\n${session.query}` }
    ];

    const draftingInstructions = DRAFTING_PROMPT + (targeted.length > 0
      ? `\n\n=== TARGETED CONTEXT (Only you can see this) ===\n${targeted.join("\n\n")}`
      : "");

    const draftingMessages = [
      ...stablePrefixMessages,
      { role: "user", content: draftingInstructions },
    ];

    const response = await callLLM(model, draftingMessages, session.reasoningEffort);
    return { model, ...response };
  });

  const drafts: CouncilMemberResponse[] = await Promise.all(draftPromises);
  
  // Parse confidence for each draft
  drafts.forEach(d => {
    const confMatch = d.content.match(/Confidence:\s*(Low|Medium|High)/i);
    if (confMatch) {
      d.confidence = confMatch[1];
    }
  });

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
  const uniqueRFIs = Array.from(new Set(allRFIs)).filter(path => !session.requestedPaths.includes(path));

  if (uniqueRFIs.length > 0 && !force && session.rfiRoundCount < 2) {
    session.rfiRoundCount++;
    session.status = "STALLED_RFI";
    session.requestedPaths.push(...uniqueRFIs); // Record these requests
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
    // STABLE PREFIX: Reusing the exact same prefix as Phase 1
    const stablePrefixMessages = [
      { role: "system", content: "You are a member of an expert LLM Council. Your goal is to provide a comprehensive, accurate, and insightful answer." },
      { role: "user", content: `=== SHARED CONTEXT ===\n${session.sharedContext || "No shared context provided."}\n\n=== USER QUERY ===\n${session.query}` }
    ];

    const reviewInstructions = `Ground Truth Context (including consolidated targeted data):\n${groundTruth}\n\n${REVIEW_PROMPT}\n\n${reviewPacket}`;

    const reviewMessages = [
      ...stablePrefixMessages,
      { role: "user", content: reviewInstructions },
    ];

    const response = await callLLM(model, reviewMessages, session.reasoningEffort);
    return { model, ...response };
  });

  const reviews: CouncilMemberResponse[] = await Promise.all(reviewPromises);
  session.reviews = reviews;

  // Extract Consensus Score (average of scores provided by reviewers)
  let totalScore = 0;
  let scoreCount = 0;
  reviews.forEach(r => {
    const scoreMatch = r.content.match(/Consensus Score:\s*(\d+)/i);
    if (scoreMatch) {
      const score = parseInt(scoreMatch[1]);
      if (!isNaN(score)) {
        totalScore += score;
        scoreCount++;
      }
    }
  });
  session.consensusScore = scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0;

  session.status = "COMPLETED";

  const output: CouncilOutput = {
    drafts,
    reviews,
    synthesis_instructions: SYNTHESIS_PROMPT,
    consensus_score: session.consensusScore,
    total_usage: {
      prompt_tokens: [...drafts, ...reviews].reduce((acc, r) => acc + (r.usage?.prompt_tokens || 0), 0),
      completion_tokens: [...drafts, ...reviews].reduce((acc, r) => acc + (r.usage?.completion_tokens || 0), 0),
      total_tokens: [...drafts, ...reviews].reduce((acc, r) => acc + (r.usage?.total_tokens || 0), 0),
    },
    session_id: session.id,
    timestamp: Date.now()
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
    finalize: z.boolean().optional().default(false).describe("If true, removes the session from memory after completion."),
  },
  async ({ session_id, force, format, finalize }) => {
    const result = await runDeliberationLogic(session_id, force);
    if ("error" in result) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }
    
    if (finalize && "output" in result) {
      sessionStore.deleteSession(process.cwd(), session_id);
    }

    if ("rfi" in result) {
      return { content: [{ type: "text", text: JSON.stringify(result.rfi, null, 2) }] };
    }
    if (format === "json") {
      return { content: [{ type: "text", text: JSON.stringify({ ...result.output, report: result.report }, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify({ ...delibRes.output, report: delibRes.report }, null, 2) }] };
    }
    return { content: [{ type: "text", text: delibRes.report }] };
  }
);

/**
 * Generates a structured Markdown report for the TUI and Chairman synthesis.
 */
function generateMarkdownReport(output: CouncilOutput): string {
  const { drafts, reviews, total_usage, synthesis_instructions, session_id, consensus_score } = output;

  let md = "# 🏛️ Council Deliberation\n\n";

  // Consensus Meter
  if (consensus_score > 0) {
    const filled = "█".repeat(consensus_score);
    const empty = "░".repeat(10 - consensus_score);
    md += `### ⚖️ Consensus Meter: ${consensus_score}/10\n`;
    md += `\`[${filled}${empty}]\`\n\n`;
  }

  // Salience: Put instructions at the top for the Chairman
  md += "## 🛠️ Synthesis Instructions\n";
  md += `${synthesis_instructions}\n\n`;

  // Member Summary Table
  md += "### 👥 Member Status\n\n";
  md += "| Member | Model | Confidence | Drafting | Review | Tokens |\n";
  md += "| :--- | :--- | :---: | :---: | :---: | :---: |\n";

  drafts.forEach((d, i) => {
    const r = reviews?.[i];
    const dStatus = d.error ? "❌" : "✅";
    const rStatus = r ? (r.error ? "❌" : "✅") : "-";
    const dTokens = (d.usage?.total_tokens || 0) + (r?.usage?.total_tokens || 0);
    const conf = d.confidence || "??";
    md += `| ${i + 1} | \`${d.model}\` | ${conf} | ${dStatus} | ${rStatus} | ${dTokens.toLocaleString()} |\n`;
  });
  md += "\n";

  // Sentiment Summary
  if (consensus_score > 0) {
    let sentiment = "";
    if (consensus_score >= 8) sentiment = "🤝 **United**: The council is in strong agreement.";
    else if (consensus_score >= 5) sentiment = "⚖️ **Balanced**: There is a general consensus with some minor dissent or nuances.";
    else sentiment = "🗣️ **Divided**: The council is significantly split on the resolution.";
    md += `**Council Sentiment**: ${sentiment}\n\n`;
  }

  md += `> 📄 **Full Audit Trail**: Raw deliberations are available at \`council://sessions/${session_id}/raw-deliberation\`\n\n`;

  md += "---\n";

  // Drafts Section
  md += "## 🖋️ Member Drafts\n\n";
  drafts.forEach((d, i) => {
    md += `### Member ${i + 1} (\`${d.model}\`)\n`;
    if (d.error) {
      md += `> ❌ **Error**: ${d.error}\n\n`;
    } else {
      if (d.reasoning) {
        md += `<details>\n<summary>View Reasoning</summary>\n\n${d.reasoning}\n\n</details>\n\n`;
      }
      md += `${d.content}\n\n`;
    }
  });

  // Reviews Section
  if (reviews && reviews.length > 0) {
    md += "---\n";
    md += "## 🔍 Peer Reviews\n\n";
    reviews.forEach((r, i) => {
      md += `### Review ${i + 1} (\`${r.model}\`)\n`;
      if (r.error) {
        md += `> ❌ **Error**: ${r.error}\n\n`;
      } else {
        if (r.reasoning) {
          md += `<details>\n<summary>View Reasoning</summary>\n\n${r.reasoning}\n\n</details>\n\n`;
        }
        md += `${r.content}\n\n`;
      }
    });
  }

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
