#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  acceptanceExitCode,
  CODEX_ACCEPTANCE_ACCESS_CODE_ENV,
  formatSafeReport,
  parseAcceptanceArgs,
  runCodexAcceptance,
  type SafeReport,
} from './codex-acceptance-lib';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<0 | 1> {
  let options;
  try {
    options = parseAcceptanceArgs(argv);
  } catch {
    process.stdout.write('FAIL stage=arguments error=argument\n');
    return 1;
  }

  let reports: SafeReport[];
  try {
    reports = await runCodexAcceptance({
      ...options,
      ...(env[CODEX_ACCEPTANCE_ACCESS_CODE_ENV]
        ? { accessCode: env[CODEX_ACCEPTANCE_ACCESS_CODE_ENV] }
        : {}),
    });
  } catch {
    reports = [{ outcome: 'FAIL', stage: 'harness', errorCategory: 'unexpected' }];
  }
  process.stdout.write(`${reports.map(formatSafeReport).join('\n')}\n`);
  return acceptanceExitCode(reports);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
