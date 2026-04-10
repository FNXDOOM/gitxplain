import React, { useMemo, useState } from 'react';
import { Sparkles, AlertTriangle, GitBranch, Coins, Workflow } from 'lucide-react';
import { useCommitStoryStore } from '../store/commitStoryStore';

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function normalizeOutput(text: string): string {
  return stripAnsi(String(text || '')).trim();
}

type CostStats = {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  raw: string;
};

export default function AnalysisView() {
  const { currentProject, commits, selectedCommit, setSelectedCommit } = useCommitStoryStore();
  const [aiLoading, setAiLoading] = useState(false);
  const [aiOutput, setAiOutput] = useState('');
  const [analysisTitle, setAnalysisTitle] = useState('Analysis Output');
  const [stashRef, setStashRef] = useState('stash@{0}');
  const [blameFilePath, setBlameFilePath] = useState('');
  const [conflictDiffFile, setConflictDiffFile] = useState('');

  const [costLoading, setCostLoading] = useState(false);
  const [costStats, setCostStats] = useState<CostStats | null>(null);

  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineError, setPipelineError] = useState('');
  const [pipelineAnalysis, setPipelineAnalysis] = useState<any>(null);
  const [pipelineOptionId, setPipelineOptionId] = useState('');
  const [pipelineResult, setPipelineResult] = useState<any>(null);

  const recentCommits = useMemo(() => commits.slice(0, 200), [commits]);

  const runAction = async (
    title: string,
    action: () => Promise<{ output: string; error?: string }>
  ) => {
    setAiLoading(true);
    setAnalysisTitle(title);
    try {
      const result = await action();
      if (result.error) {
        setAiOutput(`${title} failed:\n\n${result.error}\n\n${normalizeOutput(result.output)}`.trim());
      } else {
        setAiOutput(normalizeOutput(result.output));
      }
    } catch (error: any) {
      setAiOutput(`${title} failed: ${error.message}`);
    } finally {
      setAiLoading(false);
    }
  };

  const runCommitMode = async (
    title: string,
    action: (repoPath: string, commitRef: string) => Promise<{ output: string; error?: string }>
  ) => {
    if (!currentProject || !selectedCommit) return;
    await runAction(title, () => action(currentProject.path, selectedCommit.hash));
  };

  const handleConflictAnalysis = async () => {
    if (!currentProject) return;
    const diffFile = conflictDiffFile.trim() || undefined;
    await runAction('Merge Conflict Analysis', () => window.electronAPI.gitxplainConflict(currentProject.path, diffFile));
  };

  const handleStashAnalysis = async () => {
    if (!currentProject) return;
    const ref = stashRef.trim() || 'stash@{0}';
    setStashRef(ref);
    await runAction(`Stash Analysis (${ref})`, () => window.electronAPI.gitxplainStash(currentProject.path, ref));
  };

  const handleBlameAnalysis = async () => {
    if (!currentProject) return;
    const filePath = blameFilePath.trim();
    if (!filePath) {
      setAnalysisTitle('Blame Analysis');
      setAiOutput('Enter a file path before running blame analysis.');
      return;
    }
    await runAction(`Blame Analysis (${filePath})`, () => window.electronAPI.gitxplainBlame(currentProject.path, filePath));
  };

  const handleLoadCost = async () => {
    if (!currentProject) return;
    setCostLoading(true);
    setPipelineError('');
    try {
      const result = await window.electronAPI.gitxplainCost(currentProject.path);
      if (result.error) {
        setPipelineError(result.error);
      } else {
        setCostStats(result.stats);
      }
    } catch (error: any) {
      setPipelineError(error.message || 'Failed to load usage stats.');
    } finally {
      setCostLoading(false);
    }
  };

  const handleDetectPipelines = async () => {
    if (!currentProject) return;
    setPipelineLoading(true);
    setPipelineError('');
    setPipelineResult(null);
    try {
      const analysis = await window.electronAPI.gitxplainPipelineOptions(currentProject.path);
      setPipelineAnalysis(analysis);
      setPipelineOptionId(analysis.options?.[0]?.id || '');
    } catch (error: any) {
      setPipelineError(error.message || 'Failed to inspect repository for pipelines.');
    } finally {
      setPipelineLoading(false);
    }
  };

  const handleGeneratePipeline = async (writeFiles: boolean) => {
    if (!currentProject || !pipelineOptionId) return;
    setPipelineLoading(true);
    setPipelineError('');
    try {
      const result = await window.electronAPI.gitxplainPipelineGenerate(
        currentProject.path,
        pipelineOptionId,
        writeFiles
      );
      setPipelineResult(result);
    } catch (error: any) {
      setPipelineError(error.message || 'Failed to generate pipeline.');
    } finally {
      setPipelineLoading(false);
    }
  };

  if (!currentProject) {
    return null;
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Analysis Studio</h2>
        <p className="text-muted-foreground">
          Run all upstream gitxplain analysis modes, CI pipeline generation, and cost tracking from one place.
        </p>
      </div>

      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" />
          <h3 className="text-lg font-semibold">Commit Analysis Modes</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Selected Commit</label>
            <select
              value={selectedCommit?.hash || ''}
              onChange={(event) => {
                const commit = recentCommits.find((item) => item.hash === event.target.value) || null;
                setSelectedCommit(commit);
              }}
              className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground"
            >
              <option value="">Select a commit</option>
              {recentCommits.map((commit) => (
                <option key={commit.hash} value={commit.hash}>
                  {commit.hash.substring(0, 7)} - {commit.message}
                </option>
              ))}
            </select>
          </div>
          <div className="text-xs text-muted-foreground self-end">
            Uses the same provider/model configured in Settings.
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <button onClick={() => runCommitMode('Full Explanation', (r, c) => window.electronAPI.gitxplainExplain(r, c, 'full'))} disabled={aiLoading || !selectedCommit} className="px-3 py-2 rounded-md bg-primary text-primary-foreground disabled:opacity-50">Explain</button>
          <button onClick={() => runCommitMode('Code Review', window.electronAPI.gitxplainReview)} disabled={aiLoading || !selectedCommit} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Review</button>
          <button onClick={() => runCommitMode('Security Analysis', window.electronAPI.gitxplainSecurity)} disabled={aiLoading || !selectedCommit} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Security</button>
          <button onClick={() => runCommitMode('Line-by-Line Walkthrough', window.electronAPI.gitxplainLines)} disabled={aiLoading || !selectedCommit} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Lines</button>
          <button onClick={() => runCommitMode('Refactor Suggestions', window.electronAPI.gitxplainRefactor)} disabled={aiLoading || !selectedCommit} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Refactor</button>
          <button onClick={() => runCommitMode('Test Suggestions', window.electronAPI.gitxplainTestSuggest)} disabled={aiLoading || !selectedCommit} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Test Suggest</button>
          <button onClick={() => runCommitMode('PR Description', window.electronAPI.gitxplainPrDescription)} disabled={aiLoading || !selectedCommit} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">PR Description</button>
          <button onClick={() => runCommitMode('Changelog Draft', window.electronAPI.gitxplainChangelog)} disabled={aiLoading || !selectedCommit} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Changelog</button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5" />
          <h3 className="text-lg font-semibold">Working Tree and File Analysis</h3>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Blame File Path</label>
            <input value={blameFilePath} onChange={(e) => setBlameFilePath(e.target.value)} placeholder="src/path/to/file.ts" className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground" />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Conflict Diff File (optional)</label>
            <input value={conflictDiffFile} onChange={(e) => setConflictDiffFile(e.target.value)} placeholder="src/path/to/file.ts" className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground" />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Stash Ref</label>
            <input value={stashRef} onChange={(e) => setStashRef(e.target.value)} placeholder="stash@{0}" className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground" />
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <button onClick={handleBlameAnalysis} disabled={aiLoading} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Run Blame</button>
          <button onClick={handleConflictAnalysis} disabled={aiLoading} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Analyze Conflicts</button>
          <button onClick={handleStashAnalysis} disabled={aiLoading} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Explain Stash</button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Coins className="w-5 h-5" />
              <h3 className="text-lg font-semibold">Usage and Cost</h3>
            </div>
            <button onClick={handleLoadCost} disabled={costLoading} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">{costLoading ? 'Loading...' : 'Refresh'}</button>
          </div>

          {costStats ? (
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Requests" value={String(costStats.requestCount)} />
              <Metric label="Total Tokens" value={costStats.totalTokens.toLocaleString()} />
              <Metric label="Input Tokens" value={costStats.inputTokens.toLocaleString()} />
              <Metric label="Output Tokens" value={costStats.outputTokens.toLocaleString()} />
              <Metric label="Estimated Cost (USD)" value={`$${costStats.estimatedCostUsd.toFixed(6)}`} className="col-span-2" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No usage stats loaded yet.</p>
          )}
        </div>

        <div className="bg-card border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Workflow className="w-5 h-5" />
              <h3 className="text-lg font-semibold">Pipeline Generator</h3>
            </div>
            <button onClick={handleDetectPipelines} disabled={pipelineLoading} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">{pipelineLoading ? 'Detecting...' : 'Detect'}</button>
          </div>

          {pipelineError && <p className="text-sm text-red-700">{pipelineError}</p>}

          {pipelineAnalysis?.supported ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Detected {pipelineAnalysis.primary?.type || 'project'} ({pipelineAnalysis.primary?.displayName || currentProject.name}).
              </p>
              <select value={pipelineOptionId} onChange={(e) => setPipelineOptionId(e.target.value)} className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground">
                {pipelineAnalysis.options.map((option: any) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <button onClick={() => handleGeneratePipeline(false)} disabled={pipelineLoading || !pipelineOptionId} className="px-3 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50">Preview YAML</button>
                <button onClick={() => handleGeneratePipeline(true)} disabled={pipelineLoading || !pipelineOptionId} className="px-3 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Create Files</button>
              </div>
            </div>
          ) : pipelineAnalysis ? (
            <p className="text-sm text-muted-foreground">{pipelineAnalysis.reason || 'Pipeline generation is not supported here.'}</p>
          ) : (
            <p className="text-sm text-muted-foreground">Detect pipeline options to start.</p>
          )}
        </div>
      </div>

      {pipelineResult?.generatedFiles && (
        <div className="bg-card border border-border rounded-lg p-4 space-y-3">
          <h3 className="text-lg font-semibold">Generated Pipeline YAML</h3>
          {Object.entries(pipelineResult.generatedFiles).map(([filePath, yaml]) => (
            <div key={filePath} className="border border-border rounded-md">
              <div className="px-3 py-2 border-b border-border bg-muted/50 flex items-center justify-between">
                <span className="text-sm font-mono">{filePath}</span>
                <button onClick={() => navigator.clipboard.writeText(String(yaml))} className="text-xs px-2 py-1 rounded border border-border hover:bg-accent">Copy</button>
              </div>
              <pre className="text-xs p-3 overflow-x-auto max-h-56 bg-background">{String(yaml)}</pre>
            </div>
          ))}
          {pipelineResult.writtenFiles?.length > 0 && (
            <p className="text-xs text-green-700">Created: {pipelineResult.writtenFiles.join(', ')}</p>
          )}
        </div>
      )}

      <div className="bg-card border border-border rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-2">{analysisTitle}</h3>
        {aiLoading ? (
          <p className="text-sm text-muted-foreground">Running analysis...</p>
        ) : aiOutput ? (
          <pre className="text-sm whitespace-pre-wrap bg-background border border-border rounded-md p-4 max-h-[60vh] overflow-auto">{aiOutput}</pre>
        ) : (
          <p className="text-sm text-muted-foreground">Run an analysis mode to view output here.</p>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={`p-3 border border-border rounded-md bg-background ${className}`.trim()}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </div>
  );
}
