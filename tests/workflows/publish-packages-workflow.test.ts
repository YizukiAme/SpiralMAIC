import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

const workflowSource = readFileSync(
  resolve(process.cwd(), '.github/workflows/publish-packages.yml'),
  'utf8',
);

function parseWorkflow(source = workflowSource): Workflow {
  return load(source) as Workflow;
}

function step(workflow: Workflow, jobName: string, name: string): WorkflowStep {
  const match = workflow.jobs[jobName]?.steps.find((candidate) => candidate.name === name);
  expect(match, `${jobName} must contain "${name}"`).toBeDefined();
  return match!;
}

function assertPublishedVersionHandoff(workflow: Workflow): void {
  const publish = workflow.jobs.publish;
  const publishStep = step(
    workflow,
    'publish',
    'Registry preflight and publish validated tarballs',
  );
  const mark = workflow.jobs.mark;
  const markStep = step(workflow, 'mark', 'Write missing release markers');

  expect(publish.outputs).toEqual({
    published_versions: '${{ steps.publish.outputs.published_versions }}',
  });
  expect(publishStep.id).toBe('publish');
  expect(publishStep.run).toContain('published_versions=""');
  expect(publishStep.run).toContain(
    'published_versions="${published_versions:+$published_versions,}$name@$version"',
  );
  expect(publishStep.run).toContain(
    'printf \'published_versions=%s\\n\' "$published_versions" >> "$GITHUB_OUTPUT"',
  );

  expect(mark.needs).toBe('publish');
  expect(markStep.env).toMatchObject({
    PUBLISHED_VERSIONS: '${{ needs.publish.outputs.published_versions }}',
  });
  expect(markStep.run).toContain('if [[ ",$PUBLISHED_VERSIONS," == *",$tag,"* ]]; then');
  expect(markStep.run).toContain(
    'Published $tag in this run; registry propagation is not required.',
  );
  expect(markStep.run).toContain(
    'elif ! npm view "$name@$version" version --registry https://registry.npmjs.org >/dev/null 2>&1; then',
  );
}

describe('publish-package marker workflow contract', () => {
  it('keeps the token-bearing publish job confined to the canonical repository', () => {
    const workflow = parseWorkflow();

    expect(workflow.jobs.publish.if).toContain("github.repository == 'THU-MAIC/OpenMAIC'");
  });

  it('hands exact successful publishes to the marker job without losing reconciliation', () => {
    assertPublishedVersionHandoff(parseWorkflow());
  });

  it.each([
    [
      'drops the publish output',
      (source: string) =>
        source.replace(
          'published_versions: ${{ steps.publish.outputs.published_versions }}',
          'published_versions: ""',
        ),
    ],
    [
      'reintroduces the registry race for current publishes',
      (source: string) =>
        source.replace('if [[ ",$PUBLISHED_VERSIONS," == *",$tag,"* ]]; then', 'if false; then'),
    ],
    [
      'drops registry reconciliation for older releases',
      (source: string) =>
        source.replace(
          'elif ! npm view "$name@$version" version --registry https://registry.npmjs.org >/dev/null 2>&1; then',
          'elif false; then',
        ),
    ],
  ])('rejects a broken handoff that %s', (_name, mutate) => {
    const mutated = mutate(workflowSource);
    expect(mutated).not.toBe(workflowSource);
    expect(() => assertPublishedVersionHandoff(parseWorkflow(mutated))).toThrow();
  });
});

describe('package validation source selection', () => {
  function validate(environment: Record<string, string>) {
    const directory = mkdtempSync(join(tmpdir(), 'spiral-package-workflow-'));
    try {
      mkdirSync(join(directory, 'scripts'));
      // Exercise the actual workflow shell; record its package-check boundary
      // without contacting the upstream registry or publishing anything.
      writeFileSync(
        join(directory, 'scripts/check-package-version-bumps.mjs'),
        'console.log(JSON.stringify(process.argv.slice(2))); process.exit(process.argv[2] ? 0 : 2);',
      );
      return spawnSync(
        'bash',
        ['-c', step(parseWorkflow(), 'validate', 'Validate package versions').run!],
        { cwd: directory, env: { ...process.env, ...environment }, encoding: 'utf8' },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('retains registry release validation for the upstream repository', () => {
    const result = validate({
      GITHUB_REPOSITORY: 'THU-MAIC/OpenMAIC',
      GITHUB_EVENT_NAME: 'push',
      PACKAGE_VERSION_BASE: 'a'.repeat(40),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(['--release']);
  });

  it('validates a fork push against its own before-SHA, not the upstream registry', () => {
    const base = 'b'.repeat(40);
    const result = validate({
      GITHUB_REPOSITORY: 'YizukiAme/SpiralMAIC',
      GITHUB_EVENT_NAME: 'push',
      PACKAGE_VERSION_BASE: base,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([base]);
  });

  it('checks a manually requested fork validation against origin/main', () => {
    const result = validate({
      GITHUB_REPOSITORY: 'YizukiAme/SpiralMAIC',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      PACKAGE_VERSION_BASE: '',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(['origin/main']);
  });

  it('does not silently waive a fork push with no usable base', () => {
    const result = validate({
      GITHUB_REPOSITORY: 'YizukiAme/SpiralMAIC',
      GITHUB_EVENT_NAME: 'push',
      PACKAGE_VERSION_BASE: '',
    });
    expect(result.status).not.toBe(0);
  });
});
