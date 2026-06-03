import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromDatabasePackage = createRequire(
  path.join(rootDir, "packages", "database", "package.json"),
);
const { Pool } = requireFromDatabasePackage("pg");
const databaseUrl =
  process.env.SMOKE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://knoviq:knoviq_dev_password@127.0.0.1:55432/knoviq";
const jwtAccessSecret =
  process.env.SMOKE_JWT_ACCESS_SECRET ?? "task-16-smoke-access-secret-with-at-least-32-chars";
const jwtRefreshSecret =
  process.env.SMOKE_JWT_REFRESH_SECRET ?? "task-16-smoke-refresh-secret-with-at-least-32-chars";

const runId = randomUUID().slice(0, 12);
const uploadDir = path.join(rootDir, "tmp", `task16-invoice-${runId}`);
const children = [];
let smokeUserEmail;
let smokeTenantId;
let smokeUserId;

async function main() {
  await mkdir(uploadDir, { recursive: true });
  await applyMigrations();

  const ports = await getFreePorts(4);
  const [authPort, aiPort, knowledgePort, toolPort] = ports;
  const serviceEnv = {
    ...process.env,
    AI_GATEWAY_MODEL_PROVIDER: "local",
    AI_GATEWAY_PORT: String(aiPort),
    AUTH_SERVICE_PORT: String(authPort),
    CACHE_KEY_PREFIX: `knoviq-smoke-${runId}`,
    DATABASE_URL: databaseUrl,
    HOST: "127.0.0.1",
    JWT_ACCESS_SECRET: jwtAccessSecret,
    JWT_AUDIENCE: "knoviq-api",
    JWT_ISSUER: "knoviq-auth-service",
    JWT_REFRESH_SECRET: jwtRefreshSecret,
    KAFKA_ENABLED: "false",
    KNOWLEDGE_CHUNK_OVERLAP_CHARS: "0",
    KNOWLEDGE_CHUNK_TARGET_CHARS: "400",
    KNOWLEDGE_EMBEDDING_PROVIDER: "local",
    KNOWLEDGE_SEARCH_CACHE_TTL_SECONDS: "0",
    KNOWLEDGE_SERVICE_PORT: String(knowledgePort),
    KNOWLEDGE_SERVICE_URL: `http://127.0.0.1:${knowledgePort}`,
    KNOWLEDGE_UPLOAD_DIR: uploadDir,
    LOG_LEVEL: process.env.SMOKE_LOG_LEVEL ?? "error",
    NODE_ENV: "test",
    OTEL_TRACES_ENABLED: "false",
    REDIS_ENABLED: "false",
    TOOL_DEFINITIONS_CACHE_TTL_SECONDS: "0",
    TOOL_EXECUTION_SERVICE_PORT: String(toolPort),
    TOOL_EXECUTION_SERVICE_URL: `http://127.0.0.1:${toolPort}`,
  };

  startService("auth-service", "apps/auth-service/dist/server.js", serviceEnv);
  startService("knowledge-service", "apps/knowledge-service/dist/server.js", serviceEnv);
  startService("tool-execution-service", "apps/tool-execution-service/dist/server.js", serviceEnv);
  startService("ai-gateway", "apps/ai-gateway/dist/server.js", serviceEnv);

  await Promise.all([
    waitForHealth(`http://127.0.0.1:${authPort}/health`),
    waitForHealth(`http://127.0.0.1:${knowledgePort}/health`),
    waitForHealth(`http://127.0.0.1:${toolPort}/health`),
    waitForHealth(`http://127.0.0.1:${aiPort}/health`),
  ]);

  const authBaseUrl = `http://127.0.0.1:${authPort}`;
  const knowledgeBaseUrl = `http://127.0.0.1:${knowledgePort}`;
  const aiBaseUrl = `http://127.0.0.1:${aiPort}`;
  smokeUserEmail = `task16-${runId}@example.test`;

  const auth = await postJson(`${authBaseUrl}/auth/register`, {
    email: smokeUserEmail,
    fullName: "Task 16 Smoke User",
    password: "Task16-Smoke-Password-123!",
    tenantName: `Task 16 Smoke ${runId}`,
  });
  const accessToken = auth.tokens?.accessToken;
  smokeTenantId = auth.user?.tenantId;
  smokeUserId = auth.user?.userId;
  assert(accessToken, "Auth registration did not return an access token");

  await uploadTextInvoice({
    accessToken,
    baseUrl: knowledgeBaseUrl,
    content:
      "Vendor: Alpha Services\nInvoice Number: APR-ALPHA-16\nInvoice Date: April 05, 2026\nDescription: April support services\nTotal Due: USD 120.00\n",
    filename: `alpha-april-${runId}.txt`,
    title: `Alpha April Invoice ${runId}`,
  });
  await uploadTextInvoice({
    accessToken,
    baseUrl: knowledgeBaseUrl,
    content:
      "Vendor: Beta Supplies\nInvoice Number: APR-BETA-16\nInvoice Date: April 20, 2026\nDescription: April office supplies\nAmount Due: USD 80.00\n",
    filename: `beta-april-${runId}.txt`,
    title: `Beta April Invoice ${runId}`,
  });

  const chat = await postJson(
    `${aiBaseUrl}/chat`,
    {
      message: "Summarize uploaded invoices and calculate total expenses for April 2026.",
    },
    accessToken,
  );

  assert(chat.validation?.status === "grounded", "Expected grounded validation status");
  const toolNames = chat.toolCalls?.map((call) => call.toolName) ?? [];
  assert(
    includesInOrder(toolNames, [
      "knowledge.retrieve",
      "document.extract_invoice_fields",
      "calculator.evaluate",
    ]),
    `Expected invoice tool chain, got: ${toolNames.join(", ")}`,
  );

  const extraction = chat.toolCalls.find(
    (call) => call.toolName === "document.extract_invoice_fields",
  )?.output;
  assert(extraction?.invoiceCount === 2, "Expected two extracted invoices");
  assert(
    extraction?.totalAmount === 200,
    `Expected extracted total 200, got ${extraction?.totalAmount}`,
  );

  const calculation = chat.toolCalls.find(
    (call) => call.toolName === "calculator.evaluate",
  )?.output;
  assert(calculation?.result === 200, `Expected calculator result 200, got ${calculation?.result}`);
  assert(chat.answer?.includes("USD 200.00"), "Expected answer to include USD 200.00");

  console.log(
    JSON.stringify(
      {
        answerIncludes: "USD 200.00",
        calculatorResult: calculation.result,
        extractedTotal: extraction.totalAmount,
        invoiceCount: extraction.invoiceCount,
        status: "passed",
        toolNames,
        validationStatus: chat.validation.status,
      },
      null,
      2,
    ),
  );
}

async function applyMigrations() {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const migrationDir = path.join(rootDir, "infra", "migrations");
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();

  try {
    for (const file of files) {
      const sql = await readFile(path.join(migrationDir, file), "utf8");
      await pool.query(sql);
    }
  } finally {
    await pool.end();
  }
}

function startService(name, scriptPath, env) {
  const verbose = process.env.SMOKE_VERBOSE === "true";
  const child = spawn(process.execPath, [path.join(rootDir, scriptPath)], {
    cwd: rootDir,
    env,
    stdio: verbose ? ["ignore", "pipe", "pipe"] : "ignore",
  });

  child.stdout?.on("data", (chunk) => {
    if (verbose) {
      process.stdout.write(`[${name}] ${chunk}`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    if (verbose) {
      process.stderr.write(`[${name}] ${chunk}`);
    }
  });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`${name} exited with code ${code}`);
    }
    if (signal && process.env.SMOKE_VERBOSE === "true") {
      console.error(`${name} exited from ${signal}`);
    }
  });
  children.push(child);
}

async function waitForHealth(url) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "unknown error"}`);
}

async function postJson(url, body, accessToken) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    method: "POST",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function uploadTextInvoice(input) {
  const form = new FormData();
  form.append("title", input.title);
  form.append("visibility", "tenant");
  form.append("metadata", JSON.stringify({ smokeRunId: runId, type: "invoice" }));
  form.append("file", new Blob([input.content], { type: "text/plain" }), input.filename);

  const response = await fetch(`${input.baseUrl}/documents`, {
    body: form,
    headers: {
      authorization: `Bearer ${input.accessToken}`,
    },
    method: "POST",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Document upload returned ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function getFreePorts(count) {
  const ports = [];

  for (let index = 0; index < count; index += 1) {
    ports.push(await getFreePort());
  }

  return ports;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate a free port"));
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function includesInOrder(values, expected) {
  let expectedIndex = 0;
  for (const value of values) {
    if (value === expected[expectedIndex]) {
      expectedIndex += 1;
    }
  }
  return expectedIndex === expected.length;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupSmokeData() {
  if (!smokeTenantId && !smokeUserEmail) {
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const tenantId =
      smokeTenantId ??
      (
        await pool.query(
          "SELECT primary_tenant_id FROM knoviq.users WHERE lower(email) = lower($1)",
          [smokeUserEmail],
        )
      ).rows[0]?.primary_tenant_id;
    const userId =
      smokeUserId ??
      (
        await pool.query("SELECT id FROM knoviq.users WHERE lower(email) = lower($1)", [
          smokeUserEmail,
        ])
      ).rows[0]?.id;

    if (!tenantId || !userId) {
      return;
    }

    await pool.query("BEGIN");
    await pool.query("DELETE FROM knoviq.audit_logs WHERE tenant_id = $1 OR actor_user_id = $2", [
      tenantId,
      userId,
    ]);
    await pool.query("DELETE FROM knoviq.service_metrics WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.tool_executions WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.llm_usage WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.message_citations WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.messages WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.conversations WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.document_access_grants WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.document_chunks WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.documents WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.embedding_cache WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM knoviq.refresh_tokens WHERE tenant_id = $1 OR user_id = $2", [
      tenantId,
      userId,
    ]);
    await pool.query("DELETE FROM knoviq.tenant_memberships WHERE tenant_id = $1", [tenantId]);
    await pool.query("UPDATE knoviq.users SET primary_tenant_id = NULL WHERE id = $1", [userId]);
    await pool.query("DELETE FROM knoviq.users WHERE id = $1", [userId]);
    await pool.query("DELETE FROM knoviq.tenants WHERE id = $1", [tenantId]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    if (process.env.SMOKE_VERBOSE === "true") {
      console.error(`Smoke data cleanup failed: ${error.message}`);
    }
  } finally {
    await pool.end();
  }
}

async function cleanup() {
  await Promise.all(children.map((child) => killChildProcess(child)));
  await cleanupSmokeData();
  await rm(uploadDir, { force: true, recursive: true });
}

async function killChildProcess(child) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      killer.on("error", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }

      const timeout = setTimeout(resolve, 3_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup();
    process.exit(1);
  });
