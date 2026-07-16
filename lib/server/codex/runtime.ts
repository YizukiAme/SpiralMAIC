import { CodexLoginManager } from './login-manager';
import { FileCodexModelCatalogStore, type CodexModelCatalogStore } from './model-cache-store';
import { CodexModelDiscovery, getCodexCredentialGeneration } from './models';
import {
  invalidateCodexCredentialLeases,
  ManagedCodexTokenProvider,
  type CodexClock,
  type TokenExchangeFetch,
} from './token-provider';
import {
  FileCodexCredentialVault,
  withCodexCredentialVaultMutation,
  type CodexCredentialVault,
} from './vault';
import { ensureCodexRuntimeLock } from './runtime-lock';

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
  catalogStore?: CodexModelCatalogStore;
  clock?: CodexClock;
}

// v5 adds account/catalog capability leases; never reuse a pre-lease HMR runtime.
const RUNTIME_KEY = Symbol.for('openmaic.codex.oauth.auth-runtime.v5');
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
  const catalogStore = options.catalogStore ?? new FileCodexModelCatalogStore();
  const clearModelCatalog = (): Promise<void> => modelDiscovery.clear();
  const tokenProvider: ManagedCodexTokenProvider = new ManagedCodexTokenProvider({
    vault,
    onCredentialsCleared: clearModelCatalog,
    ...(options.oauthFetch ? { tokenExchangeFetch: options.oauthFetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const loginManager = new CodexLoginManager({
    vault,
    onCredentialsReplaced: async () => {
      invalidateCodexCredentialLeases(tokenProvider);
      await clearModelCatalog();
    },
    ...(options.oauthFetch ? { oauthFetch: options.oauthFetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const modelDiscovery: CodexModelDiscovery = new CodexModelDiscovery({
    tokenProvider,
    credentialGeneration: () => getCodexCredentialGeneration(vault),
    credentialAccountId: async () => {
      const credentials = await withCodexCredentialVaultMutation(vault, () => vault.load());
      return credentials?.accountId ?? null;
    },
    catalogStore,
    ...(options.modelsFetch ? { upstreamFetch: options.modelsFetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { vault, tokenProvider, loginManager, modelDiscovery };
}

export function getCodexAuthRuntime(): CodexAuthRuntime {
  // Process-wide and HMR-safe. The assertion happens before returning even an
  // existing HMR runtime, so a second live Node process can never reuse the
  // same on-disk Codex auth area.
  ensureCodexRuntimeLock();
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
