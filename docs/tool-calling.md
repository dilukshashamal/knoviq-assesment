# Tool Calling

## How It Works

The AI Gateway does not execute tools directly. It fetches tool definitions from the Tool Execution Service, sends a plan to the LLM, and calls `POST /tools/execute` for each selected tool. Results flow back to the synthesizer as grounded evidence.

## End-to-End Flow

```
POST /chat { message: "..." }
        │
        ▼
  1. Load recent conversation memory (last 12 messages)
        │
        ▼
  2. Fetch tool definitions  GET /tools
     (cached in Redis for 300s)
        │
        ▼
  3. PLANNER  gpt-4o-mini, temp=0
     Input:  recent memory + tool definitions + user message
     Output: JSON { toolCalls: [{ toolName, arguments, reason }] }

     KB-first rule: always call knowledge.retrieve for factual questions.
     Safety net: if planner returns no tools for a non-greeting,
     AgentRunner injects knowledge.retrieve automatically.
        │
        ▼
  4. For each planned tool call:

     AI Gateway  ──►  POST /tools/execute  ──►  Tool Execution Service
                       { toolName, arguments,
                         conversationId, messageId }
                                │
                    ┌───────────┴────────────┐
                    │                        │
                    ▼                        ▼
            knowledge.retrieve       calculator.evaluate
            ──► Knowledge Service    ──► In-process parser
                POST /search                 │
                                    sql.query_safe
                                    ──► PostgreSQL (read-only)
                                             │
                                    extract_invoice_fields
                                    ──► Azure OpenAI LLM
        │
        ▼
  5. Follow-up chaining (up to 4 rounds)
     Invoice workflow: retrieve → extract_invoice_fields → calculator
        │
        ▼
  6. SYNTHESIZER  gpt-4o, temp=0.1
     Receives numbered citation chunks + tool outputs
     Produces grounded answer with document references
        │
        ▼
  7. VALIDATOR  gpt-4o-mini, temp=0
     Checks every claim against retrieved chunk snippets
        │
        ▼
  8. Guardrail applies → final answer
        │
        ▼
  Response { answer, toolCalls, validation, conversationId }
```

## Tool Execution Lifecycle

Every execution goes through this lifecycle in the Tool Execution Service:

1. Parse and validate `ExecuteToolRequestSchema` (Zod).
2. Write `tool_executions` row with status `running`.
3. Dispatch to the registered `ToolHandler.execute()`.
4. On success: update row with output, latency, status `succeeded`.
5. On failure: update row with error code, error message, status `failed`.
6. Publish `tool.execution.completed` → Kafka.
7. Return structured result to the AI Gateway.

Tool failures return a `failed` result — they do not crash the agent. The synthesizer receives the failure and explains it in plain language.

## Tool Definition Caching

The AI Gateway caches `GET /tools` in Redis with `TOOL_DEFINITIONS_CACHE_TTL_SECONDS=300` (5 minutes). This avoids an HTTP round-trip on every chat turn at high request rates. The cache key is scoped to the Tool Execution Service URL. If tool definitions ever become role-specific or tenant-specific, the cache key must include those identity fields.

## Invoice Chaining

The runner detects invoice-related messages and automatically chains tools:

```
knowledge.retrieve  (minSimilarity: -1, all relevant chunks)
        │
        ▼
document.extract_invoice_fields
        │  LLM reads any invoice format
        │  Returns: invoices[], grandTotal, expression
        ▼
calculator.evaluate
        │  Input: grandTotal from extraction
        │  (not a sum of potentially misextracted amounts)
        ▼
Synthesizer
```

Each intermediate step is logged in `knoviq.tool_executions`, included in the streaming `tool_result` events, and stored in assistant message metadata for full auditability.

## SQL Safety

`sql.query_safe` is an operation registry. The LLM selects an operation name (`document_count`, `llm_usage_summary`, etc.) but never provides raw SQL strings. Every operation:

- uses parameterised queries
- filters by `tenant_id` from the verified access token
- is read-only
- has a configurable row limit (`TOOL_SQL_MAX_LIMIT=50`)
