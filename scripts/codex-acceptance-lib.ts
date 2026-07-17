// Stable public API for the CLI and tests. Implementation stays split by trust boundary.
export {
  acceptanceExitCode,
  formatSafeReport,
  normalizePublicBaseUrl,
  parseAcceptanceArgs,
} from './codex-acceptance-report';
export { runCodexAcceptance } from './codex-acceptance-runner';
export {
  CODEX_ACCEPTANCE_ACCESS_CODE_ENV,
  type AcceptanceDependencies,
  type AcceptanceOptions,
  type AcceptanceOutcome,
  type SafeErrorCategory,
  type SafeReport,
} from './codex-acceptance-types';
export {
  parseJsonSse,
  validateCodexCatalog,
  validateEditorEvents,
  validateOutlineEvents,
  validateSceneJson,
  validateVerificationJson,
} from './codex-acceptance-validators';
