import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import isDev from 'electron-is-dev';
import simpleGit from 'simple-git';
import Store from 'electron-store';
import { spawn } from 'child_process';
import fs from 'fs';
import { pathToFileURL } from 'url';

// Resolve gitxplain CLI path for both dev and packaged layouts.
const CLI_CANDIDATES = [
  path.join(__dirname, '../cli/index.js'),
  path.join(process.cwd(), 'cli/index.js'),
  path.join(__dirname, '../../cli/index.js'),
];
const GITXPLAIN_CLI = CLI_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || CLI_CANDIDATES[0];
const PIPELINE_SERVICE_MODULE = pathToFileURL(path.join(path.dirname(GITXPLAIN_CLI), 'services', 'pipelineService.js')).href;

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const startUrl = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, 'renderer/index.html')}`;

  mainWindow.loadURL(startUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Initialize electron-store for persistent settings
const store = new Store() as any;

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  html_url: string;
  default_branch: string;
}

function sanitizeFolderName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '-').trim();
}

function buildClonePath(baseDir: string, repoName: string): string {
  const safeName = sanitizeFolderName(repoName) || 'repository';
  let candidate = path.join(baseDir, safeName);
  let suffix = 1;

  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = path.join(baseDir, `${safeName}-${suffix}`);
  }

  return candidate;
}

// IPC handlers
ipcMain.handle('get-app-path', () => {
  return app.getAppPath();
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Folder selection for adding repositories
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Git Repository',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('github-list-repos', async (event, token: string) => {
  const trimmedToken = String(token || '').trim();
  if (!trimmedToken) {
    throw new Error('GitHub token is missing. Add it in Settings first.');
  }

  const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
    headers: {
      Authorization: `token ${trimmedToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gitxplain-gui',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to load GitHub repositories (${response.status}): ${body}`);
  }

  const repos = (await response.json()) as GitHubRepo[];
  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    cloneUrl: repo.clone_url,
    htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch,
  }));
});

ipcMain.handle('github-clone-repo', async (event, { cloneUrl, fullName, token }) => {
  const baseDir = path.join(app.getPath('documents'), 'gitxplain-repos');
  fs.mkdirSync(baseDir, { recursive: true });

  const targetPath = buildClonePath(baseDir, fullName || 'repository');
  const authToken = String(token || '').trim();
  let authenticatedUrl = String(cloneUrl || '');

  if (authToken && authenticatedUrl.startsWith('https://')) {
    authenticatedUrl = authenticatedUrl.replace(
      'https://',
      `https://x-access-token:${encodeURIComponent(authToken)}@`
    );
  }

  const git = simpleGit();
  await git.clone(authenticatedUrl, targetPath, ['--depth', '200']);

  return targetPath;
});

// Get Git commit log
ipcMain.handle('git-log', async (event, repoPath, options = {}) => {
  try {
    const git = simpleGit(repoPath);
    const log = await git.log({
      maxCount: options.maxCount || 500,
      from: options.from,
      to: options.to,
    });
    
    return log.all.map(commit => ({
      hash: commit.hash,
      author: commit.author_name,
      email: commit.author_email,
      date: commit.date,
      message: commit.message,
      body: commit.body,
    }));
  } catch (error: any) {
    console.error('Git log error:', error);
    throw new Error(`Failed to get git log: ${error.message}`);
  }
});

// Get commit details with diff and stats
ipcMain.handle('git-details', async (event, { path: repoPath, hash }) => {
  try {
    const git = simpleGit(repoPath);
    
    // Get commit show with stats
    const show = await git.show([hash, '--stat', '--format=%H|%an|%ae|%aI|%s|%b']);
    const numstat = await git.show([hash, '--numstat', '--format=']);
    
    // Get full diff
    const diff = await git.diff([`${hash}^`, hash]);
    
    // Parse file stats from show output
    const statsMatch = show.match(/(\d+) files? changed/);
    const insertionsMatch = show.match(/(\d+) insertions?/);
    const deletionsMatch = show.match(/(\d+) deletions?/);
    const files = numstat
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // Accept both tab-delimited and whitespace-delimited numstat output.
        const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
        if (!match) return null;

        const additions = Number.parseInt(match[1], 10);
        const deletions = Number.parseInt(match[2], 10);
        const path = match[3]?.trim();

        if (!path) return null;

        const safeAdditions = Number.isFinite(additions) ? additions : 0;
        const safeDeletions = Number.isFinite(deletions) ? deletions : 0;

        return {
          path,
          additions: safeAdditions,
          deletions: safeDeletions,
          changes: safeAdditions + safeDeletions,
        };
      })
      .filter((file): file is { path: string; additions: number; deletions: number; changes: number } => file !== null);
    
    return {
      diff,
      stats: {
        filesChanged: statsMatch ? parseInt(statsMatch[1]) : 0,
        insertions: insertionsMatch ? parseInt(insertionsMatch[1]) : 0,
        deletions: deletionsMatch ? parseInt(deletionsMatch[1]) : 0,
      },
      files,
    };
  } catch (error: any) {
    console.error('Git details error:', error);
    throw new Error(`Failed to get commit details: ${error.message}`);
  }
});

// Get repository status
ipcMain.handle('git-status', async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    const status = await git.status();
    
    return {
      modified: status.modified,
      created: status.created,
      deleted: status.deleted,
      renamed: status.renamed,
      staged: status.staged,
      files: status.files,
    };
  } catch (error: any) {
    console.error('Git status error:', error);
    throw new Error(`Failed to get git status: ${error.message}`);
  }
});

// Create commit
ipcMain.handle('git-commit', async (event, { path: repoPath, message, files }) => {
  try {
    const git = simpleGit(repoPath);
    
    // Stage files if provided
    if (files && files.length > 0) {
      await git.add(files);
    } else {
      // Stage all changes if no specific files provided
      await git.add('.');
    }
    
    // Commit
    const result = await git.commit(message);
    return result.commit;
  } catch (error: any) {
    console.error('Git commit error:', error);
    throw new Error(`Failed to create commit: ${error.message}`);
  }
});

// Check if directory is a git repository
ipcMain.handle('git-is-repo', async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    const isRepo = await git.checkIsRepo();
    return isRepo;
  } catch (error) {
    return false;
  }
});

// Get current branch
ipcMain.handle('git-current-branch', async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    const branch = await git.branch();
    return branch.current;
  } catch (error: any) {
    console.error('Git branch error:', error);
    throw new Error(`Failed to get current branch: ${error.message}`);
  }
});

// List local branches and current branch
ipcMain.handle('git-list-branches', async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    await git.fetch(['--all', '--prune']);
    const branchInfo = await git.branchLocal();
    const allBranchInfo = await git.branch(['-a']);

    const remoteOnlyBranches = allBranchInfo.all
      .filter((name) => name.startsWith('remotes/origin/'))
      .filter((name) => !name.includes('HEAD ->'))
      .map((name) => name.replace(/^remotes\/origin\//, ''))
      .filter((name) => name && !branchInfo.all.includes(name));

    const mergedBranches = [...new Set([...branchInfo.all, ...remoteOnlyBranches])].sort((left, right) => {
      if (left === branchInfo.current) return -1;
      if (right === branchInfo.current) return 1;
      return left.localeCompare(right);
    });

    return {
      current: branchInfo.current,
      all: mergedBranches,
    };
  } catch (error: any) {
    console.error('Git list branches error:', error);
    throw new Error(`Failed to list branches: ${error.message}`);
  }
});

// Checkout branch
ipcMain.handle('git-checkout-branch', async (event, { repoPath, branchName }) => {
  try {
    const git = simpleGit(repoPath);
    const targetBranch = String(branchName || '').trim();
    if (!targetBranch) {
      throw new Error('Branch name is required');
    }

    const localBranches = await git.branchLocal();
    if (localBranches.all.includes(targetBranch)) {
      await git.checkout(targetBranch);
    } else {
      const remoteBranch = `origin/${targetBranch}`;
      try {
        await git.checkout(['--track', remoteBranch]);
      } catch {
        await git.checkout(targetBranch);
      }
    }

    const branchInfo = await git.branchLocal();
    return branchInfo.current;
  } catch (error: any) {
    console.error('Git checkout error:', error);
    throw new Error(`Failed to checkout branch: ${error.message}`);
  }
});

// Push current branch to origin
ipcMain.handle('git-push-current-branch', async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    const branchInfo = await git.branchLocal();
    const currentBranch = branchInfo.current;

    if (!currentBranch) {
      throw new Error('No active branch to push');
    }

    try {
      await git.push('origin', currentBranch);
    } catch {
      await git.push(['--set-upstream', 'origin', currentBranch]);
    }

    return currentBranch;
  } catch (error: any) {
    console.error('Git push error:', error);
    throw new Error(`Failed to push current branch: ${error.message}`);
  }
});

// Store operations for settings
ipcMain.handle('store-get', (event, key) => {
  return store.get(key);
});

ipcMain.handle('store-set', (event, key, value) => {
  store.set(key, value);
  return true;
});

ipcMain.handle('store-delete', (event, key) => {
  store.delete(key);
  return true;
});

// ============================================
// GITXPLAIN CLI INTEGRATION
// ============================================

interface GitxplainOptions {
  repoPath: string;
  commitRef: string;
  mode:
    | 'summary'
    | 'full'
    | 'review'
    | 'security'
    | 'lines'
    | 'issues'
    | 'fix'
    | 'impact'
    | 'split'
    | 'refactor'
    | 'test-suggest'
    | 'pr-description'
    | 'changelog';
  format?: 'plain' | 'json' | 'markdown' | 'html';
  provider?: string;
  model?: string;
  extraArgs?: string[];
  stdinText?: string;
}

type ProviderId = 'openai' | 'groq' | 'openrouter' | 'gemini' | 'chutes' | 'ollama';

function normalizeSettingString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getProviderApiKey(provider: ProviderId, aiSettings: any): string | undefined {
  if (provider === 'openai') return normalizeSettingString(aiSettings.openaiKey);
  if (provider === 'groq') return normalizeSettingString(aiSettings.groqKey);
  if (provider === 'openrouter') return normalizeSettingString(aiSettings.openrouterKey);
  if (provider === 'gemini') return normalizeSettingString(aiSettings.geminiKey);
  if (provider === 'chutes') return normalizeSettingString(aiSettings.chutesKey);
  return undefined;
}

function resolveProviderAndModel(
  aiSettings: any,
  providerOverride?: string,
  modelOverride?: string
): { provider: ProviderId; model?: string } {
  const requestedProvider = (normalizeSettingString(providerOverride) || normalizeSettingString(aiSettings.provider) || 'openai') as ProviderId;
  const requestedModel = normalizeSettingString(modelOverride) || normalizeSettingString(aiSettings.model);

  if (requestedProvider === 'ollama') {
    return { provider: 'ollama', model: requestedModel };
  }

  if (getProviderApiKey(requestedProvider, aiSettings)) {
    return { provider: requestedProvider, model: requestedModel };
  }

  const fallbackProvider = (['openai', 'groq', 'openrouter', 'gemini', 'chutes'] as ProviderId[])
    .find((provider) => getProviderApiKey(provider, aiSettings));

  if (fallbackProvider) {
    return { provider: fallbackProvider };
  }

  return { provider: requestedProvider, model: requestedModel };
}

// Helper to run gitxplain CLI as subprocess
function runGitxplain(options: GitxplainOptions): Promise<{ output: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const settings = store.get('settings') as any || {};
    const aiSettings = settings.ai || {};
    const resolved = resolveProviderAndModel(aiSettings, options.provider, options.model);
    const effectiveProvider = resolved.provider;
    const effectiveModel = resolved.model;

    const args = [
      GITXPLAIN_CLI,
      options.commitRef,
      `--${options.mode}`,
    ];
    
    // Add format flag
    if (options.format && options.format !== 'plain') {
      args.push(`--${options.format}`);
    }
    
    // Add provider/model overrides
    args.push('--provider', effectiveProvider);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }
    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }
    
    // Build environment with API keys - define all keys upfront for TypeScript
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LLM_PROVIDER: effectiveProvider,
      LLM_MODEL: effectiveModel,
      OPENAI_API_KEY: normalizeSettingString(aiSettings.openaiKey),
      GROQ_API_KEY: normalizeSettingString(aiSettings.groqKey),
      OPENROUTER_API_KEY: normalizeSettingString(aiSettings.openrouterKey),
      GEMINI_API_KEY: normalizeSettingString(aiSettings.geminiKey),
      CHUTES_API_KEY: normalizeSettingString(aiSettings.chutesKey),
      OLLAMA_BASE_URL: normalizeSettingString(aiSettings.ollamaBaseUrl),
    };
    
    const proc = spawn(process.execPath, ['--no-warnings', ...args], {
      cwd: options.repoPath,
      env,
      shell: false,
      windowsHide: true,
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.stdin.on('error', () => {
      // Ignore EPIPE/closed stdin errors when child exits quickly.
    });

    if (options.stdinText) {
      if (!proc.stdin.destroyed && proc.stdin.writable) {
        proc.stdin.write(options.stdinText);
      }
      if (!proc.stdin.destroyed) {
        proc.stdin.end();
      }
    } else if (!proc.stdin.destroyed) {
      proc.stdin.end();
    }
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ output: stdout.trim() });
      } else {
        resolve({ output: stdout.trim(), error: stderr.trim() || 'Command failed' });
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to run gitxplain: ${err.message}`));
    });
  });
}

function runGitxplainCommand(repoPath: string, args: string[]): Promise<{ output: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const settings = store.get('settings') as any || {};
    const aiSettings = settings.ai || {};
    const resolved = resolveProviderAndModel(aiSettings);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LLM_PROVIDER: resolved.provider,
      LLM_MODEL: resolved.model,
      OPENAI_API_KEY: normalizeSettingString(aiSettings.openaiKey),
      GROQ_API_KEY: normalizeSettingString(aiSettings.groqKey),
      OPENROUTER_API_KEY: normalizeSettingString(aiSettings.openrouterKey),
      GEMINI_API_KEY: normalizeSettingString(aiSettings.geminiKey),
      CHUTES_API_KEY: normalizeSettingString(aiSettings.chutesKey),
      OLLAMA_BASE_URL: normalizeSettingString(aiSettings.ollamaBaseUrl),
    };

    const proc = spawn(process.execPath, ['--no-warnings', GITXPLAIN_CLI, ...args], {
      cwd: repoPath,
      env,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ output: stdout.trim() });
      } else {
        resolve({ output: stdout.trim(), error: stderr.trim() || 'Command failed' });
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run gitxplain command: ${err.message}`));
    });
  });
}

function runNodeModuleScript(repoPath: string, script: string): Promise<{ output: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repoPath,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ output: stdout.trim() });
      } else {
        resolve({ output: stdout.trim(), error: stderr.trim() || 'Command failed' });
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run node module script: ${err.message}`));
    });
  });
}

function parseUsageStatsOutput(output: string) {
  const lines = output.split(/\r?\n/).map((line) => line.trim());

  const readNumber = (prefix: string): number => {
    const line = lines.find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
    if (!line) return 0;
    const value = Number(line.split(':')[1]?.trim().replace(/,/g, ''));
    return Number.isFinite(value) ? value : 0;
  };

  const estimatedLine = lines.find((item) => item.toLowerCase().startsWith('estimated cost:'));
  const estimatedCostUsd = estimatedLine
    ? Number(estimatedLine.split(':')[1]?.replace('$', '').trim()) || 0
    : 0;

  return {
    requestCount: readNumber('Requests:'),
    inputTokens: readNumber('Input Tokens:'),
    outputTokens: readNumber('Output Tokens:'),
    totalTokens: readNumber('Total Tokens:'),
    estimatedCostUsd,
    raw: output,
  };
}

// Explain a commit (summary or full analysis)
ipcMain.handle('gitxplain-explain', async (event, { repoPath, commitRef, mode = 'full' }) => {
  try {
    const result = await runGitxplain({
      repoPath,
      commitRef,
      mode,
      format: 'markdown',
    });
    return result;
  } catch (error: any) {
    console.error('Gitxplain explain error:', error);
    throw new Error(`Failed to explain commit: ${error.message}`);
  }
});

// Get summary of a commit
ipcMain.handle('gitxplain-summary', async (event, { repoPath, commitRef }) => {
  try {
    const result = await runGitxplain({
      repoPath,
      commitRef,
      mode: 'summary',
      format: 'plain',
    });
    return result;
  } catch (error: any) {
    console.error('Gitxplain summary error:', error);
    throw new Error(`Failed to summarize commit: ${error.message}`);
  }
});

// Code review
ipcMain.handle('gitxplain-review', async (event, { repoPath, commitRef }) => {
  try {
    const result = await runGitxplain({
      repoPath,
      commitRef,
      mode: 'review',
      format: 'markdown',
    });
    return result;
  } catch (error: any) {
    console.error('Gitxplain review error:', error);
    throw new Error(`Failed to review commit: ${error.message}`);
  }
});

// Security analysis
ipcMain.handle('gitxplain-security', async (event, { repoPath, commitRef }) => {
  try {
    const result = await runGitxplain({
      repoPath,
      commitRef,
      mode: 'security',
      format: 'markdown',
    });
    return result;
  } catch (error: any) {
    console.error('Gitxplain security error:', error);
    throw new Error(`Failed to analyze security: ${error.message}`);
  }
});

// Line-by-line explanation
ipcMain.handle('gitxplain-lines', async (event, { repoPath, commitRef }) => {
  try {
    const result = await runGitxplain({
      repoPath,
      commitRef,
      mode: 'lines',
      format: 'markdown',
    });
    return result;
  } catch (error: any) {
    console.error('Gitxplain lines error:', error);
    throw new Error(`Failed to explain lines: ${error.message}`);
  }
});

// Branch/range analysis (for Stories)
ipcMain.handle('gitxplain-branch', async (event, { repoPath, baseRef, mode = 'full' }) => {
  try {
    // Use range format: baseRef..HEAD
    const commitRef = `${baseRef}..HEAD`;
    const result = await runGitxplain({
      repoPath,
      commitRef,
      mode,
      format: 'markdown',
    });
    return result;
  } catch (error: any) {
    console.error('Gitxplain branch error:', error);
    throw new Error(`Failed to analyze branch: ${error.message}`);
  }
});

// Install git hook for current repository
ipcMain.handle('gitxplain-install-hook', async (event, { repoPath, hookName = 'post-commit' }) => {
  try {
    const result = await runGitxplainCommand(repoPath, ['install-hook', hookName]);
    return result;
  } catch (error: any) {
    console.error('Gitxplain install-hook error:', error);
    throw new Error(`Failed to install hook: ${error.message}`);
  }
});

// Commit split preview
ipcMain.handle('gitxplain-split-preview', async (event, { repoPath, commitRef }) => {
  try {
    const result = await runGitxplain({
      repoPath,
      commitRef,
      mode: 'split',
      format: 'plain',
      extraArgs: ['--dry-run'],
    });
    return result;
  } catch (error: any) {
    console.error('Gitxplain split preview error:', error);
    throw new Error(`Failed to generate split preview: ${error.message}`);
  }
});

// Commit split execution with explicit confirmation
ipcMain.handle('gitxplain-split-execute', async (event, { repoPath, commitRef }) => {
  try {
    const result = await runGitxplain({
      repoPath,
      commitRef,
      mode: 'split',
      format: 'plain',
      extraArgs: ['--execute'],
      stdinText: 'yes\n',
    });
    return result;
  } catch (error: any) {
    console.error('Gitxplain split execute error:', error);
    throw new Error(`Failed to execute split: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-refactor', async (event, { repoPath, commitRef }) => {
  try {
    return await runGitxplain({
      repoPath,
      commitRef,
      mode: 'refactor',
      format: 'markdown',
    });
  } catch (error: any) {
    console.error('Gitxplain refactor error:', error);
    throw new Error(`Failed to suggest refactors: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-test-suggest', async (event, { repoPath, commitRef }) => {
  try {
    return await runGitxplain({
      repoPath,
      commitRef,
      mode: 'test-suggest',
      format: 'markdown',
    });
  } catch (error: any) {
    console.error('Gitxplain test-suggest error:', error);
    throw new Error(`Failed to suggest tests: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-pr-description', async (event, { repoPath, commitRef }) => {
  try {
    return await runGitxplain({
      repoPath,
      commitRef,
      mode: 'pr-description',
      format: 'markdown',
    });
  } catch (error: any) {
    console.error('Gitxplain pr-description error:', error);
    throw new Error(`Failed to draft PR description: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-changelog', async (event, { repoPath, commitRef }) => {
  try {
    return await runGitxplain({
      repoPath,
      commitRef,
      mode: 'changelog',
      format: 'markdown',
    });
  } catch (error: any) {
    console.error('Gitxplain changelog error:', error);
    throw new Error(`Failed to draft changelog: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-blame', async (event, { repoPath, filePath }) => {
  try {
    return await runGitxplainCommand(repoPath, ['--blame', filePath, '--markdown']);
  } catch (error: any) {
    console.error('Gitxplain blame error:', error);
    throw new Error(`Failed to run blame analysis: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-conflict', async (event, { repoPath, diffFile }) => {
  try {
    const args = ['--conflict', '--markdown'];
    if (diffFile && String(diffFile).trim()) {
      args.push('--diff', String(diffFile).trim());
    }
    return await runGitxplainCommand(repoPath, args);
  } catch (error: any) {
    console.error('Gitxplain conflict error:', error);
    throw new Error(`Failed to analyze merge conflict: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-stash', async (event, { repoPath, stashRef, diffFile }) => {
  try {
    const args = ['--stash'];
    if (stashRef && String(stashRef).trim()) {
      args.push(String(stashRef).trim());
    }
    args.push('--markdown');
    if (diffFile && String(diffFile).trim()) {
      args.push('--diff', String(diffFile).trim());
    }
    return await runGitxplainCommand(repoPath, args);
  } catch (error: any) {
    console.error('Gitxplain stash error:', error);
    throw new Error(`Failed to analyze stash: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-cost', async (event, { repoPath }) => {
  try {
    const result = await runGitxplainCommand(repoPath, ['--cost']);
    return {
      ...result,
      stats: parseUsageStatsOutput(result.output),
    };
  } catch (error: any) {
    console.error('Gitxplain cost error:', error);
    throw new Error(`Failed to load usage stats: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-pipeline-options', async (event, { repoPath }) => {
  try {
    const script = `
      const mod = await import(${JSON.stringify(PIPELINE_SERVICE_MODULE)});
      const analysis = mod.inspectRepositoryForPipeline(process.cwd());
      process.stdout.write(JSON.stringify(analysis));
    `;

    const result = await runNodeModuleScript(repoPath, script);
    if (result.error) {
      return { supported: false, reason: result.error, options: [], existingWorkflows: [] };
    }

    return JSON.parse(result.output);
  } catch (error: any) {
    console.error('Pipeline detect error:', error);
    throw new Error(`Failed to inspect repository for pipelines: ${error.message}`);
  }
});

ipcMain.handle('gitxplain-pipeline-generate', async (event, { repoPath, optionId, writeFiles = false }) => {
  try {
    const safeOptionId = JSON.stringify(String(optionId || ''));
    const safeWriteFiles = writeFiles ? 'true' : 'false';

    const script = `
      const mod = await import(${JSON.stringify(PIPELINE_SERVICE_MODULE)});
      const analysis = mod.inspectRepositoryForPipeline(process.cwd());

      if (!analysis.supported) {
        throw new Error(analysis.reason || 'Pipeline generation is not supported for this repository.');
      }

      const selection = analysis.options.find((option) => option.id === ${safeOptionId});
      if (!selection) {
        throw new Error('Invalid pipeline option selected.');
      }

      const generatedFiles = {};

      if (selection.id === 'ci' || selection.id === 'ci-release') {
        generatedFiles['.github/workflows/ci.yml'] = mod.buildCiWorkflow(analysis.primary);
      }
      if (selection.id === 'ci-release') {
        generatedFiles['.github/workflows/release.yml'] = mod.buildReleaseWorkflow(analysis.primary);
      }
      if (selection.id === 'container') {
        generatedFiles['.github/workflows/container.yml'] = mod.buildContainerWorkflow();
      }
      if (selection.id === 'gitlab-ci') {
        generatedFiles['.gitlab-ci.yml'] = mod.buildGitLabCiWorkflow(analysis.primary);
      }
      if (selection.id === 'circleci') {
        generatedFiles['.circleci/config.yml'] = mod.buildCircleCiWorkflow(analysis.primary);
      }
      if (selection.id === 'bitbucket-pipelines') {
        generatedFiles['bitbucket-pipelines.yml'] = mod.buildBitbucketPipelinesWorkflow(analysis.primary);
      }

      let writtenFiles = [];
      let notes = [];

      if (${safeWriteFiles}) {
        const writeResult = mod.writePipelineFiles(process.cwd(), analysis, selection);
        writtenFiles = writeResult.writtenFiles;
        notes = writeResult.notes;
      }

      process.stdout.write(JSON.stringify({
        selection,
        generatedFiles,
        writtenFiles,
        notes,
      }));
    `;

    const result = await runNodeModuleScript(repoPath, script);
    if (result.error) {
      throw new Error(result.error);
    }

    return JSON.parse(result.output);
  } catch (error: any) {
    console.error('Pipeline generate error:', error);
    throw new Error(`Failed to generate pipeline: ${error.message}`);
  }
});
