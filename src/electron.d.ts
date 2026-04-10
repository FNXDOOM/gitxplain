/**
 * TypeScript declarations for Electron API
 */

export interface GitLogOptions {
  maxCount?: number;
  from?: string;
  to?: string;
}

export interface GitCommitDetails {
  diff: string;
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    changes: number;
  }>;
}

export interface GitStatusResult {
  modified: string[];
  created: string[];
  deleted: string[];
  renamed: string[];
  staged: string[];
  files: any[];
}

export interface GitxplainResult {
  output: string;
  error?: string;
}

export interface GitxplainCostResult extends GitxplainResult {
  stats: {
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    raw: string;
  };
}

export interface PipelineOption {
  id: string;
  label: string;
  description: string;
  files: string[];
}

export interface PipelineAnalysis {
  supported: boolean;
  reason?: string;
  primary?: {
    type: string;
    displayName: string;
    packageManager?: string;
  };
  existingWorkflows: string[];
  options: PipelineOption[];
}

export interface PipelineGenerationResult {
  selection: PipelineOption;
  generatedFiles: Record<string, string>;
  writtenFiles: string[];
  notes: string[];
}

export interface GitBranchList {
  current: string;
  all: string[];
}

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
}

export interface ElectronAPI {
  // Folder selection
  selectFolder: () => Promise<string | null>;
  
  // Git operations
  getLog: (path: string, options?: GitLogOptions) => Promise<any[]>;
  getCommitDetails: (path: string, hash: string) => Promise<GitCommitDetails>;
  getStatus: (path: string) => Promise<GitStatusResult>;
  commit: (path: string, message: string, files?: string[]) => Promise<string>;
  pushCurrentBranch: (path: string) => Promise<string>;
  isRepo: (path: string) => Promise<boolean>;
  getCurrentBranch: (path: string) => Promise<string>;
  listBranches: (path: string) => Promise<GitBranchList>;
  checkoutBranch: (path: string, branchName: string) => Promise<string>;
  
  // Store operations
  storeGet: (key: string) => Promise<any>;
  storeSet: (key: string, value: any) => Promise<boolean>;
  storeDelete: (key: string) => Promise<boolean>;

  // GitHub integration
  githubListRepos: (token: string) => Promise<GitHubRepo[]>;
  githubCloneRepo: (cloneUrl: string, fullName: string, token: string) => Promise<string>;
  
  // Gitxplain AI operations
  gitxplainExplain: (repoPath: string, commitRef: string, mode?: string) => Promise<GitxplainResult>;
  gitxplainSummary: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainReview: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainSecurity: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainLines: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainBranch: (repoPath: string, baseRef: string, mode?: string) => Promise<GitxplainResult>;
  gitxplainInstallHook: (repoPath: string, hookName?: string) => Promise<GitxplainResult>;
  gitxplainSplitPreview: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainSplitExecute: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainRefactor: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainTestSuggest: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainPrDescription: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainChangelog: (repoPath: string, commitRef: string) => Promise<GitxplainResult>;
  gitxplainBlame: (repoPath: string, filePath: string) => Promise<GitxplainResult>;
  gitxplainConflict: (repoPath: string, diffFile?: string) => Promise<GitxplainResult>;
  gitxplainStash: (repoPath: string, stashRef?: string, diffFile?: string) => Promise<GitxplainResult>;
  gitxplainCost: (repoPath: string) => Promise<GitxplainCostResult>;
  gitxplainPipelineOptions: (repoPath: string) => Promise<PipelineAnalysis>;
  gitxplainPipelineGenerate: (repoPath: string, optionId: string, writeFiles?: boolean) => Promise<PipelineGenerationResult>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    electron: {
      getAppPath: () => Promise<string>;
      getAppVersion: () => Promise<string>;
      on: (channel: string, callback: (...args: any[]) => void) => void;
      once: (channel: string, callback: (...args: any[]) => void) => void;
      send: (channel: string, ...args: any[]) => void;
    };
  }
}

export {};
