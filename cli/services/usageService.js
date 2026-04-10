import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function getUsageLogPath() {
  return path.join(os.homedir(), ".gitxplain", "usage.jsonl");
}

export function getUsageLogFile() {
  return getUsageLogPath();
}

function readRecords() {
  const filePath = getUsageLogPath();
  if (!existsSync(filePath)) {
    return [];
  }

  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseNumeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeUsageMetrics(usage) {
  if (!usage || typeof usage !== "object") {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
  }

  const inputTokens =
    parseNumeric(usage.prompt_tokens) ||
    parseNumeric(usage.input_tokens) ||
    parseNumeric(usage.promptTokenCount);
  const outputTokens =
    parseNumeric(usage.completion_tokens) ||
    parseNumeric(usage.output_tokens) ||
    parseNumeric(usage.candidatesTokenCount);
  const totalTokens =
    parseNumeric(usage.total_tokens) ||
    parseNumeric(usage.totalTokenCount) ||
    inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function parseEnvPrice(envKey) {
  const raw = process.env[envKey];
  if (raw == null || raw === "") {
    return null;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function resolvePricing(config) {
  const providerKey = config.provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const modelKey = String(config.model ?? "default").toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  const inputPerMillion =
    parseEnvPrice(`${providerKey}_${modelKey}_INPUT_COST_PER_MTOK`) ??
    parseEnvPrice(`${providerKey}_INPUT_COST_PER_MTOK`) ??
    parseEnvPrice("LLM_INPUT_COST_PER_MTOK");
  const outputPerMillion =
    parseEnvPrice(`${providerKey}_${modelKey}_OUTPUT_COST_PER_MTOK`) ??
    parseEnvPrice(`${providerKey}_OUTPUT_COST_PER_MTOK`) ??
    parseEnvPrice("LLM_OUTPUT_COST_PER_MTOK");

  if (inputPerMillion == null || outputPerMillion == null) {
    return null;
  }

  return {
    inputPerMillion,
    outputPerMillion
  };
}

export function estimateCostUsd(usage, pricing) {
  if (!pricing) {
    return null;
  }

  const metrics = normalizeUsageMetrics(usage);
  const costUsd =
    (metrics.inputTokens / 1_000_000) * pricing.inputPerMillion +
    (metrics.outputTokens / 1_000_000) * pricing.outputPerMillion;

  return Number.isFinite(costUsd) ? costUsd : null;
}

export function appendUsageRecord({ provider, model, usage, latencyMs, estimatedCostUsd }) {
  const metrics = normalizeUsageMetrics(usage);
  if (metrics.totalTokens === 0 && estimatedCostUsd == null) {
    return;
  }

  const filePath = getUsageLogPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(
    filePath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      provider,
      model,
      usage: metrics,
      latencyMs: latencyMs ?? null,
      estimatedCostUsd
    })}\n`,
    "utf8"
  );
}

export function getUsageStats() {
  const records = readRecords();

  return records.reduce(
    (summary, record) => {
      summary.requestCount += 1;
      summary.inputTokens += parseNumeric(record.usage?.inputTokens);
      summary.outputTokens += parseNumeric(record.usage?.outputTokens);
      summary.totalTokens += parseNumeric(record.usage?.totalTokens);
      summary.estimatedCostUsd += parseNumeric(record.estimatedCostUsd);
      return summary;
    },
    {
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0
    }
  );
}

export function clearUsageLog() {
  const filePath = getUsageLogPath();
  const count = readRecords().length;

  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }

  return count;
}
