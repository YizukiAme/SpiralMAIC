/**
 * Revisit Judge Stability Eval
 *
 * Runs the revisit-judge prompt repeatedly on the same completed challenge and
 * checks that q plus the four dimension scores stay within scenario limits.
 *
 * Usage:
 *   EVAL_REVISIT_JUDGE_MODEL=<provider:model> pnpm eval:revisit-judge
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { callLLM } from '@/lib/ai/llm';
import { buildJudgePrompt, parseJudgeResponse } from '@/lib/revisit/prompt-builders';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import { judgeRevisitReportStability } from './judge';
import type { RevisitJudgeEvalResult, RevisitJudgeScenario } from './types';

const OUTPUT_DIR = 'eval/revisit-judge/results';

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function loadScenarios(): RevisitJudgeScenario[] {
  const path = join(getCurrentDir(), 'scenarios/stability.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as RevisitJudgeScenario[];
}

function requireModelEnv(): string {
  const model = process.env.EVAL_REVISIT_JUDGE_MODEL || process.env.DEFAULT_MODEL;
  if (!model) {
    console.error(
      'Error: EVAL_REVISIT_JUDGE_MODEL (or DEFAULT_MODEL) must be set. Example: EVAL_REVISIT_JUDGE_MODEL=openai:gpt-4.1-mini',
    );
    process.exit(1);
  }
  return model;
}

async function runScenario(
  scenario: RevisitJudgeScenario,
  model: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
): Promise<RevisitJudgeEvalResult> {
  const repetitions = scenario.repetitions ?? 2;
  const prompt = buildJudgePrompt({
    blueprint: scenario.blueprint,
    transcript: scenario.transcript,
    pageReports: scenario.pageReports,
    languageDirective: scenario.languageDirective,
  });
  const reports = [];

  for (let i = 0; i < repetitions; i += 1) {
    const result = await callLLM(
      {
        model,
        system: prompt.system,
        prompt: prompt.user,
      },
      'eval-revisit-judge',
    );
    reports.push(
      parseJudgeResponse({
        text: result.text,
        attemptId: `${scenario.case_id}-${i + 1}`,
        stageId: scenario.blueprint.stageId,
        blueprint: scenario.blueprint,
      }),
    );
  }

  const stability = judgeRevisitReportStability(reports, {
    maxQDelta: scenario.maxQDelta,
    maxDimensionDelta: scenario.maxDimensionDelta,
  });

  return {
    case_id: scenario.case_id,
    description: scenario.description,
    passed: stability.passed,
    qValues: stability.qValues,
    maxQDelta: stability.maxQDelta,
    maxDimensionDelta: stability.maxDimensionDelta,
    reason: stability.reason,
    reports,
  };
}

function writeReports(runDir: string, results: RevisitJudgeEvalResult[]) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'results.json'), JSON.stringify(results, null, 2));
  const lines = [
    '# Revisit Judge Stability Eval',
    '',
    `Passed: ${results.filter((result) => result.passed).length}/${results.length}`,
    '',
    ...results.flatMap((result) => [
      `## ${result.case_id}`,
      '',
      `- ${result.description}`,
      `- Result: ${result.passed ? 'PASS' : 'FAIL'}`,
      `- q values: ${result.qValues.map((value) => value.toFixed(3)).join(', ')}`,
      `- ${result.reason}`,
      '',
    ]),
  ];
  writeFileSync(join(runDir, 'report.md'), lines.join('\n'));
}

async function main() {
  const modelString = requireModelEnv();
  const { model } = await resolveEvalModel('EVAL_REVISIT_JUDGE_MODEL', process.env.DEFAULT_MODEL);
  const scenarios = loadScenarios();
  const runDir = createRunDir(OUTPUT_DIR, modelString);

  console.log('=== Revisit Judge Stability Eval ===');
  console.log(`Model: ${modelString}`);
  console.log(`Loaded ${scenarios.length} scenario(s)`);
  console.log(`Output: ${runDir}`);

  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, model));
  }
  writeReports(runDir, results);

  const passed = results.filter((result) => result.passed).length;
  console.log(`Passed: ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
