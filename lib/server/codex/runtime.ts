import { CodexLoginManager } from './login-manager';
import { CodexModelDiscovery, getCodexCredentialGeneration } from './models';
import {
  ManagedCodexTokenProvider,
  type CodexClock,
  type TokenExchangeFetch,
} from './token-provider';
import { FileCodexCredentialVault, type CodexCredentialVault } from './vault';

export interface CodexAuthRuntime {
  vault: CodexCredentialVault;
  tokenProvider: ManagedCodexTokenProvider;
  loginManager: CodexLoginManager;
  modelDiscovery: CodexModelDiscovery;
}

interface CreateCodexAuthRuntimeOptions {
  vault?: CodexCredentialVault;
  oauthFetch?: TokenExchangeFetch;
  modelsFetch?: typeof globalThis.fetch;
  clock?: CodexClock;
}

const RUNTIME_KEY = Symbol.for('openmaic.codex.oauth.auth-runtime.v2');
const runtimeHost = globalThis as unknown as Record<PropertyKey, unknown>;

function isCodexAuthRuntime(value: unknown): value is CodexAuthRuntime {
  if (!value || typeof value !== 'object') return false;
  const runtime = value as Partial<CodexAuthRuntime>;
  return Boolean(
    runtime.vault && runtime.tokenProvider && runtime.loginManager && runtime.modelDiscovery,
  );
}

export function createCodexAuthRuntime(
  options: CreateCodexAuthRuntimeOptions = {},
): CodexAuthRuntime {
  const vault = options.vault ?? new FileCodexCredentialVault();
  const tokenProvider = new ManagedCodexTokenProvider({
    vault,
    ...(options.oauthFetch ? { tokenExchangeFetch: options.oauthFetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const loginManager = new CodexLoginManager({
    vault,
    ...(options.oauthFetch ? { oauthFetch: options.oauthFetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const modelDiscovery = new CodexModelDiscovery({
    tokenProvider,
    credentialGeneration: () => getCodexCredentialGeneration(vault),
    ...(options.modelsFetch ? { upstreamFetch: options.modelsFetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { vault, tokenProvider, loginManager, modelDiscovery };
}

export function getCodexAuthRuntime(): CodexAuthRuntime {
  const existing = runtimeHost[RUNTIME_KEY];
  if (isCodexAuthRuntime(existing)) return existing;

  const runtime = createCodexAuthRuntime();
  Object.defineProperty(runtimeHost, RUNTIME_KEY, {
    value: runtime,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return runtime;
}
