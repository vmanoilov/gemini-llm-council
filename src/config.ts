import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { z } from 'zod';

export const CONFIG_DIR = '.gemini';
export const CONFIG_FILE_NAME = 'llm-council.json';
export const PROJECT_CONFIG_PATH = path.resolve(process.cwd(), CONFIG_DIR, CONFIG_FILE_NAME);
export const GLOBAL_CONFIG_DIR = path.resolve(os.homedir(), '.gemini', 'extensions', 'gemini-llm-council');
export const GLOBAL_CONFIG_PATH = path.resolve(GLOBAL_CONFIG_DIR, 'config.json');

export const AVAILABLE_MODELS = [
  { id: 'openai/gpt-5.2', name: 'GPT-5.2', features: { reasoning: true, caching: true } },
  { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2-Codex', features: { caching: true } },
  { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5', features: { reasoning: true, caching: true } },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', features: { reasoning: true, caching: true } },
  { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', features: { caching: true } },
  { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', features: { caching: true } },
  { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', features: { reasoning: true, caching: true } },
  { id: 'deepseek/deepseek-v3.2-speciale', name: 'DeepSeek V3.2 Speciale', features: { reasoning: true, caching: true } },
  { id: 'z-ai/glm-4.7', name: 'GLM-4.7', features: {} },
  { id: 'minimax/minimax-m2.1', name: 'Minimax M2.1', features: {} },
  { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5', features: { reasoning: true, caching: true } }
];

// Zod Schema for robust validation
// Relaxed model ID check to allow any OpenRouter model string
const CouncilConfigSchema = z.object({
  default_models: z.array(z.string().min(1, "Model ID cannot be empty")),
  default_reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional().default("none"),
});

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;

export interface CouncilStatus {
  models: string[];
  reasoning_effort: string;
  configPath: string;
  exists: boolean;
  scope: 'project' | 'global' | 'none';
}

async function readConfigFile(filePath: string): Promise<CouncilConfig | null> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    const result = CouncilConfigSchema.safeParse(parsed);
    if (!result.success) {
      console.error(`Validation error in ${filePath}:`, result.error.format());
      return null;
    }
    return result.data;
  } catch (error) {
    return null;
  }
}

export async function getCouncilConfig(): Promise<CouncilConfig> {
  // 1. Try Project Config
  const projectConfig = await readConfigFile(PROJECT_CONFIG_PATH);
  if (projectConfig) return projectConfig;

  // 2. Try Global Config
  const globalConfig = await readConfigFile(GLOBAL_CONFIG_PATH);
  if (globalConfig) return globalConfig;

  // 3. Fallback to empty defaults
  return { default_models: [], default_reasoning_effort: "none" };
}

export async function getCouncilStatus(): Promise<CouncilStatus> {
  const projectConfig = await readConfigFile(PROJECT_CONFIG_PATH);
  if (projectConfig) {
    return {
      models: projectConfig.default_models || [],
      reasoning_effort: projectConfig.default_reasoning_effort || "none",
      configPath: PROJECT_CONFIG_PATH,
      exists: true,
      scope: 'project'
    };
  }

  const globalConfig = await readConfigFile(GLOBAL_CONFIG_PATH);
  if (globalConfig) {
    return {
      models: globalConfig.default_models || [],
      reasoning_effort: globalConfig.default_reasoning_effort || "none",
      configPath: GLOBAL_CONFIG_PATH,
      exists: true,
      scope: 'global'
    };
  }

  return {
    models: [],
    reasoning_effort: "none",
    configPath: PROJECT_CONFIG_PATH, // Default path shown for setup
    exists: false,
    scope: 'none'
  };
}

export async function saveCouncilConfig(
  models: string[], 
  reasoning_effort?: "none" | "low" | "medium" | "high",
  scope: 'project' | 'global' = 'project'
): Promise<void> {
  const rawConfig = {
    default_models: models,
    default_reasoning_effort: reasoning_effort || "none"
  };
  
  // Validate before saving
  const validated = CouncilConfigSchema.parse(rawConfig);
  
  const configPath = scope === 'project' ? PROJECT_CONFIG_PATH : GLOBAL_CONFIG_PATH;
  const dir = path.dirname(configPath);

  // Ensure the directory exists
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(validated, null, 2));
}