import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PortfolioToolContext } from './tools/context.js';
import { createPortfolioToolServer } from './tools/portfolio-tools.js';
import { portfolioToolQueryOptions } from './tools/options.js';
import { PORTFOLIO_SYSTEM_PROMPT } from './instructions/portfolio-research-v1.js';
export { PORTFOLIO_SYSTEM_PROMPT, PORTFOLIO_INSTRUCTION_VERSION } from './instructions/portfolio-research-v1.js';
export { researchContext, buildResearchPrompt } from './research-context.js';

export type AgentMode = 'mock' | 'claude';
/** Server-only diagnostic trace. Arguments must never be included in browser DTOs or logs. */
export interface ToolCallTrace { tool: string; arguments: Record<string, unknown>; outcome: 'ok' | 'error'; errorCode?: string }
export interface AgentAnswer { answer: string; mode: AgentMode; toolCalls?: ToolCallTrace[] }
export interface AgentService { ask(question: string): Promise<AgentAnswer> }

export class AgentConfigurationError extends Error {}
export class AgentExecutionError extends Error {}
export class AgentTimeoutError extends AgentExecutionError {}

type QueryFunction = typeof query;
export interface ClaudeAgentOptions {
  signal?: AbortSignal;
  apiKey: string | undefined;
  modelId: string;
  workspaceDir: string;
  timeoutMs?: number;
  queryFunction?: QueryFunction;
}

function isInside(path: string, parent: string): boolean {
  const difference = relative(parent, path);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

/** Validates credentials/workspace, runs one SDK query with the given options and returns its result text. */
async function runClaude(config: ClaudeAgentOptions, question: string, defaultTimeoutMs: number, buildOptions: (base: Options) => Options): Promise<string> {
  const { apiKey, modelId, workspaceDir, timeoutMs = defaultTimeoutMs, queryFunction = query } = config;
  if (!apiKey?.trim()) throw new AgentConfigurationError('Claude API key is missing. Set ANTHROPIC_API_KEY for live agent mode.');
  if (!modelId.trim()) throw new AgentConfigurationError('AGENT_MODEL_ID is required for live agent mode.');
  if (!isAbsolute(workspaceDir)) throw new AgentConfigurationError('AGENT_WORKSPACE_DIR must be an absolute path outside the source repository.');
  const sourceRoot = await realpath(resolve(fileURLToPath(import.meta.url), '../../../..'));
  if (isInside(resolve(workspaceDir), sourceRoot)) throw new AgentConfigurationError('AGENT_WORKSPACE_DIR must be outside the source repository.');
  await mkdir(workspaceDir, { recursive: true });
  const actualWorkspace = await realpath(workspaceDir);
  if (isInside(actualWorkspace, sourceRoot)) throw new AgentConfigurationError('AGENT_WORKSPACE_DIR must be outside the source repository.');

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  config.signal?.addEventListener('abort', onAbort, { once: true });
  if (config.signal?.aborted) abortController.abort();
  const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: actualWorkspace };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const options = buildOptions({ model: modelId, cwd: actualWorkspace, env, settingSources: [], persistSession: false, permissionMode: 'dontAsk', abortController });
  const execute = async (): Promise<string> => {
    let result: SDKResultMessage | undefined;
    for await (const message of queryFunction({ prompt: question, options })) {
      if (message.type === 'result') result = message;
    }
    if (!result) throw new AgentExecutionError('Claude finished without a result.');
    if (result.subtype !== 'success' || result.is_error) throw new AgentExecutionError(`Claude stopped with ${result.subtype}.`);
    if (!result.result.trim()) throw new AgentExecutionError('Claude returned an empty answer.');
    return result.result.trim();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execute(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abortController.abort(); reject(new AgentTimeoutError('Claude did not answer within the time limit.')); }, timeoutMs);
      })
    ]);
  } catch (error) {
    if (error instanceof AgentExecutionError || error instanceof AgentConfigurationError) throw error;
    throw new AgentExecutionError('Claude could not complete the answer.');
  } finally {
    if (timer) clearTimeout(timer);
    config.signal?.removeEventListener('abort', onAbort);
  }
}

export interface ClaudePortfolioAgentOptions extends ClaudeAgentOptions {
  /** Trusted, owner-bound context built by the server from the authenticated session. */
  tools: PortfolioToolContext;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

/** Live Claude run constrained to the six read-only portfolio tools (no built-ins). */
export class ClaudePortfolioAgentService implements AgentService {
  constructor(private readonly config: ClaudePortfolioAgentOptions) {}

  async ask(question: string): Promise<AgentAnswer> {
    const { tools, maxTurns = 6, maxBudgetUsd = 0.1 } = this.config;
    const answer = await runClaude(this.config, question, 60_000, base => ({
      ...base,
      // Load our six schemas up front instead of deferring them behind tool search.
      env: { ...base.env, ENABLE_TOOL_SEARCH: 'false' },
      ...portfolioToolQueryOptions(createPortfolioToolServer(tools)),
      maxTurns, maxBudgetUsd, systemPrompt: PORTFOLIO_SYSTEM_PROMPT
    }));
    return { mode: 'claude', answer };
  }
}

export { MockPortfolioAgentService } from './mock-portfolio-agent.js';
export type { PortfolioToolContext, PortfolioToolData } from './tools/context.js';
export { createPortfolioTools, createPortfolioToolServer, PORTFOLIO_TOOL_SERVER_NAME, PORTFOLIO_TOOL_SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from './tools/portfolio-tools.js';
export type { ToolMeta, ToolResult, ToolErrorCode, FreshnessStatus } from './tools/portfolio-tools.js';
export { portfolioToolQueryOptions, portfolioToolPermissionGuard, PORTFOLIO_ALLOWED_TOOLS, DISALLOWED_BUILT_IN_TOOLS } from './tools/options.js';
export { PORTFOLIO_TOOL_NAMES, TOOL_LIMITS, toolInputSchemas, toolInputShapes } from './tools/schemas.js';
export type { PortfolioToolName } from './tools/schemas.js';
