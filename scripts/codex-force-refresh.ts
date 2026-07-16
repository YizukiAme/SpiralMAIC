#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { formatSafeReport } from './codex-acceptance-lib';
import { parseOfflineRefreshArgs, runOfflineCodexRefresh } from './codex-force-refresh-lib';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<0 | 1> {
  let options;
  try {
    options = parseOfflineRefreshArgs(argv);
  } catch {
    process.stdout.write('FAIL stage=arguments error=argument\n');
    return 1;
  }

  const report = await runOfflineCodexRefresh(options).catch(() => ({
    outcome: 'FAIL' as const,
    stage: 'offline-force-refresh',
    errorCategory: 'unexpected' as const,
  }));
  process.stdout.write(`${formatSafeReport(report)}\n`);
  return report.outcome === 'FAIL' ? 1 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
