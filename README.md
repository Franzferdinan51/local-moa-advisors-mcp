# Local MoA Advisors MCP

This stdio MCP gives an LM Studio chat model a bounded MoA pipeline:

- Advisor 1: Planner
- Advisor 2: Skeptic / technical critic
- Final aggregator: synthesizes one finished answer

The original LM Studio chat model remains the acting model. It calls
`moa_advice` and receives the aggregator's finished answer as the tool result.
Use `moa_status` first when diagnosing a reported offline state. It checks
LM Studio's native API and the currently loaded model without running an
inference request.

## Configuration

The LM Studio MCP entry starts `index.js` with Node and reads only its own MCP
environment. It does not read or depend on OpenClaw configuration.

- `LM_STUDIO_URL`: OpenAI-compatible LM Studio base URL.
- `LM_API_TOKEN`: bearer token for an authenticated LM Studio server.
- The MCP always queries LM Studio's native `/api/v1/models` endpoint and uses the currently loaded model instance. It never reads a model ID from configuration or falls back to an arbitrary installed model.
- `MOA_ADVISOR_MAX_TOKENS`: advisor response cap; defaults to `400`.
- `MOA_AGGREGATOR_MAX_TOKENS`: final synthesized response cap; defaults to `1400`.
- `MOA_REQUEST_TIMEOUT_MS`: per-request timeout; defaults to `45000`.

## Use

Call `moa_status` to verify the orchestrator/LLM path, then call `moa_advice`
only for hard tasks. Pass the task and focused context. It
makes exactly three sequential inference calls—two advisors and one aggregator—
against the same selected model, never parallel model loads. Only one MoA
request is allowed at a time, and stalled LM Studio requests are aborted.
Advisors and the aggregator do not receive MCP tool schemas and cannot act.
