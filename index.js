#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const baseUrl = (
  process.env.LM_STUDIO_URL
  || 'http://127.0.0.1:1234/v1'
).replace(/\/$/, '');
const lmStudioApiBase = baseUrl.endsWith('/v1') ? baseUrl.slice(0, -3) : baseUrl;
const apiKey = process.env.LM_API_TOKEN || '';
// Leave enough room for a complete final answer.  The MCP may be given a long
// task/context, but output limits are generated tokens, not context tokens.
const maxAdvisorTokens = Number.parseInt(process.env.MOA_ADVISOR_MAX_TOKENS || '400', 10);
const maxAggregatorTokens = Number.parseInt(process.env.MOA_AGGREGATOR_MAX_TOKENS || '1400', 10);
const requestTimeoutMs = Number.parseInt(process.env.MOA_REQUEST_TIMEOUT_MS || '45000', 10);
let activeRun = false;

function requestHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`LM Studio request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const roles = [
  {
    name: 'Planner',
    instruction: 'Break the task into the best concrete plan. Identify dependencies, ordering, and the minimum useful next actions.',
  },
  {
    name: 'Skeptic',
    instruction: 'Challenge the plan with technically precise alternatives. Find flawed assumptions, risks, missing evidence, edge cases, implementation failures, and verification gaps.',
  },
];

function textFromCompletion(data) {
  const message = data?.choices?.[0]?.message;
  const text = message?.content || message?.reasoning_content || data?.choices?.[0]?.text;
  return typeof text === 'string' && text.trim() ? text.trim() : 'No usable advisor response returned.';
}

async function getLoadedModels() {
  // The MoA must use the model already loaded in LM Studio. The
  // OpenAI-compatible endpoint lists every installed model, so it cannot be
  // used for model selection.
  const loadedResponse = await fetchWithTimeout(
    `${lmStudioApiBase}/api/v1/models`,
    { headers: requestHeaders() },
    Math.min(requestTimeoutMs, 10000),
  );
  if (loadedResponse.ok) {
    const data = await loadedResponse.json();
    return (Array.isArray(data?.models) ? data.models : [])
      .flatMap((model) => Array.isArray(model?.loaded_instances) ? model.loaded_instances : [])
      .map((instance) => instance?.id)
      .filter((id) => typeof id === 'string' && id.trim());
  }
  if (!loadedResponse.ok) {
    throw new Error(`LM Studio loaded-model discovery failed (${loadedResponse.status}). Check LM_STUDIO_URL and LM_API_TOKEN in LM Studio's mcp.json.`);
  }
  return [];
}

async function resolveLoadedModel() {
  const loadedModels = await getLoadedModels();
  if (loadedModels[0]) return loadedModels[0];
  throw new Error('No model is currently loaded in LM Studio. Load a chat model, then retry.');
}

async function askAdvisor({ role, task, context, model, temperature }) {
  const prompt = [
    'You are a private reference advisor in a Mixture-of-Agents workflow.',
    'You do not call tools or claim to execute actions. Give concise, high-signal advice to the acting model.',
    `Your assigned perspective: ${role.instruction}`,
    '',
    `Task:\n${task}`,
    context ? `\nRelevant context:\n${context}` : '',
  ].join('\n');

  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxAdvisorTokens,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${role.name} advisor failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return { role: role.name, advice: textFromCompletion(await response.json()) };
}

async function aggregateAdvice({ task, context, model, advisors }) {
  const advisorText = advisors
    .map(({ role, advice }) => `## ${role}\n${advice}`)
    .join('\n\n');
  const prompt = [
    'You are the final aggregator in a Mixture-of-Agents workflow.',
    'Two independent advisors analyzed the task below.',
    'Synthesize their strongest compatible points, resolve disagreements with your own judgment, and return one complete, actionable answer to the original task.',
    'Do not merely summarize the advisors. Do not mention this workflow unless a disagreement materially matters.',
    'Do not claim tools were run or facts were verified beyond the supplied context.',
    '',
    `Original task:\n${task}`,
    context ? `\nRelevant context:\n${context}` : '',
    `\nAdvisor reports:\n${advisorText}`,
  ].join('\n');

  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: maxAggregatorTokens,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Aggregator failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return textFromCompletion(await response.json());
}

const server = new Server(
  { name: 'local-moa-advisors', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'moa_advice',
      description: 'Run two independent local advisors followed by one local aggregator that returns a finished answer. Use for complex planning, debugging, research synthesis, or consequential code changes; do not use for simple chat.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The full task or question to analyze.' },
          context: { type: 'string', description: 'Relevant facts, constraints, errors, or excerpts. Keep it focused.' },
        },
        required: ['task'],
      },
    },
    {
      name: 'moa_status',
      description: 'Check whether LM Studio, the loaded model, and the local MoA orchestrator are actually online. This is a read-only health check and does not run inference.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'moa_status') {
    try {
      const loadedModels = await getLoadedModels();
      const status = {
        orchestrator: loadedModels.length > 0 ? 'online' : 'offline',
        llm: loadedModels.length > 0 ? 'online' : 'offline',
        loadedModels,
        endpoint: baseUrl,
        busy: activeRun,
        pipeline: loadedModels.length > 0 ? 'ready' : 'blocked: no model loaded',
      };
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ orchestrator: 'offline', llm: 'offline', endpoint: baseUrl, error: error.message }, null, 2) }], isError: true };
    }
  }
  if (request.params.name !== 'moa_advice') {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  const args = request.params.arguments || {};
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  const context = typeof args.context === 'string' ? args.context.trim() : '';
  if (!task) return { content: [{ type: 'text', text: 'task is required.' }], isError: true };
  if (activeRun) {
    return {
      content: [{
        type: 'text',
        text: 'Local MoA is already handling one request. No second advisor run was started; retry after the current call finishes.',
      }],
      isError: true,
    };
  }

  activeRun = true;
  try {
    const model = await resolveLoadedModel();
    const advisors = [];
    for (const role of roles) {
      advisors.push(await askAdvisor({ role, task, context, model, temperature: 0.55 }));
    }
    const aggregate = await aggregateAdvice({ task, context, model, advisors });
    const text = [
      `Local MoA status: orchestrator/llm online; planner online; skeptic online; aggregator online. Model: ${model}. Pipeline: 2 advisors + 1 aggregator, sequential.`,
      aggregate,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Local MoA unavailable: ${error.message}` }], isError: true };
  } finally {
    activeRun = false;
  }
});

await server.connect(new StdioServerTransport());
