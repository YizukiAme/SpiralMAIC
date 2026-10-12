import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

interface Workflow {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
}

function suiteArguments(args: string[]): string[] {
  // Worker/time budgets do not select suites. Keep every other argument so a
  // new filter or exclusion cannot silently weaken the database-backed gate.
  return args.filter((arg) => !/^--(?:maxWorkers|testTimeout|hookTimeout)=\d+$/.test(arg));
}

it('allows scheduling budgets but retains suite-selection options', () => {
  expect(
    suiteArguments([
      '--maxWorkers=1',
      '--testTimeout=60000',
      '--hookTimeout=60000',
      'a.pg.test.ts',
    ]),
  ).toEqual(['a.pg.test.ts']);
  expect(suiteArguments(['--exclude=a.pg.test.ts', '-t', 'one case', 'a.pg.test.ts'])).toEqual([
    '--exclude=a.pg.test.ts',
    '-t',
    'one case',
    'a.pg.test.ts',
  ]);
});

it('runs every tracked app PostgreSQL suite in the database-backed CI step', () => {
  const root = process.cwd();
  const workflow = load(
    readFileSync(resolve(root, '.github/workflows/storage-pg-contract.yml'), 'utf8'),
  ) as Workflow;
  const step = workflow.jobs['storage-pg-contract'].steps.find(
    (candidate) => candidate.name === 'App-domain PostgreSQL contracts',
  );
  expect(step?.run, 'The app PostgreSQL contract step must run its suites').toBeDefined();

  const command = step!
    .run!.replace(/\\\r?\n/g, ' ')
    .trim()
    .split(/\s+/);
  expect(command.slice(0, 4)).toEqual(['pnpm', 'exec', 'vitest', 'run']);

  const suites = execFileSync('git', ['ls-files', '-z', '--', 'tests/**/*.pg.test.ts'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort();
  expect(suites.length).toBeGreaterThan(0);
  expect(suiteArguments(command.slice(4)).sort()).toEqual(suites);
});
