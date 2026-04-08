#!/usr/bin/env node

import process from "node:process";
import { fetchCommitData, isGitRepository } from "./services/gitService.js";
import { generateExplanation } from "./services/aiService.js";
import { formatOutput, formatJsonOutput } from "./services/outputFormatter.js";

const ANALYSIS_FLAGS = new Map([
  ["--summary", "summary"],
  ["--issues", "issues"],
  ["--fix", "fix"],
  ["--impact", "impact"],
  ["--full", "full"]
]);

function printHelp() {
  console.log(`gitxplain - AI-powered Git commit explainer

Usage:
  gitxplain help
  gitxplain --help
  gitxplain <commit-id> [options]

Options:
  --summary    Generate a one-line summary
  --issues     Focus on bug or issue analysis
  --fix        Explain the fix in simple terms
  --impact     Explain before-vs-after behavior changes
  --full       Generate a full structured analysis
  --provider   LLM provider: openai, groq, openrouter, gemini, ollama, chutes
  --model      Override the model name
  --json       Print JSON output
  --help       Show this help message

Examples:
  gitxplain HEAD~1 --full
  gitxplain a1b2c3d --summary
  gitxplain HEAD~1 --provider groq --model llama-3.3-70b-versatile
  gitxplain HEAD~1 --provider chutes --model deepseek-ai/DeepSeek-V3-0324

Provider Setup:
  OpenAI:
    export LLM_PROVIDER=openai
    export OPENAI_API_KEY=your_key

  Groq:
    export LLM_PROVIDER=groq
    export GROQ_API_KEY=your_key

  OpenRouter:
    export LLM_PROVIDER=openrouter
    export OPENROUTER_API_KEY=your_key

  Gemini:
    export LLM_PROVIDER=gemini
    export GEMINI_API_KEY=your_key

  Ollama:
    export LLM_PROVIDER=ollama
    export OLLAMA_MODEL=llama3.2

  Chutes:
    export LLM_PROVIDER=chutes
    export CHUTES_API_KEY=your_key

Notes:
  Run gitxplain inside a Git repository.
  Use --provider or --model to override your environment for one command.
`);
}

function getFlagValue(args, flagName) {
  const directIndex = args.findIndex((arg) => arg === flagName);
  if (directIndex >= 0) {
    return args[directIndex + 1] ?? null;
  }

  const inline = args.find((arg) => arg.startsWith(`${flagName}=`));
  return inline ? inline.slice(flagName.length + 1) : null;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const subcommand = args[0];
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const valueFlags = new Set(["--provider", "--model"]);
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    if (valueFlags.has(arg)) {
      index += 1;
    }
  }

  const commitId = positional[0];
  const mode = [...ANALYSIS_FLAGS.entries()].find(([flag]) => flags.has(flag))?.[1] ?? null;

  return {
    commitId: subcommand === "help" ? null : commitId,
    json: flags.has("--json"),
    help: flags.has("--help") || subcommand === "help",
    mode,
    provider: getFlagValue(args, "--provider"),
    model: getFlagValue(args, "--model")
  };
}

function askQuestion(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (input) => {
      process.stdin.pause();
      resolve(input.trim());
    });
  });
}

async function chooseModeInteractively() {
  const answer = await askQuestion(
    [
      "What do you want to know?",
      "1. Summary",
      "2. Issues Fixed",
      "3. Fix Explanation",
      "4. Impact",
      "5. Full Analysis",
      "> "
    ].join("\n")
  );

  const selections = {
    "1": "summary",
    "2": "issues",
    "3": "fix",
    "4": "impact",
    "5": "full"
  };

  return selections[answer] ?? "full";
}

async function main() {
  const parsed = parseArgs(process.argv);

  if (parsed.help || !parsed.commitId) {
    printHelp();
    process.exit(parsed.help ? 0 : 1);
  }

  if (!isGitRepository(process.cwd())) {
    console.error("gitxplain must be run inside a Git repository.");
    process.exit(1);
  }

  const mode = parsed.mode ?? (await chooseModeInteractively());
  const commitData = fetchCommitData(parsed.commitId, process.cwd());
  const explanation = await generateExplanation({
    mode,
    commitData,
    providerOverride: parsed.provider,
    modelOverride: parsed.model
  });

  if (parsed.json) {
    console.log(formatJsonOutput({ mode, commitData, explanation }));
    return;
  }

  console.log(formatOutput({ mode, commitData, explanation }));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
