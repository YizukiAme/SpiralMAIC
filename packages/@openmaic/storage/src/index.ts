/**
 * @openmaic/storage — the MAIC pluggable persistence layer.
 *
 * Dependency arrow (kept acyclic): `@openmaic/storage -> @openmaic/dsl` only.
 * The DSL owns *what* persists (document/runtime shape + validation + migration
 * + the asset `StorageProvider` interface); this package owns *where/how* it
 * persists — the KV / asset primitives and their swappable backends. The
 * pluggable seam is the backend, not the database driver.
 *
 * `KVStore` ships a browser backend and an HTTP backend, proven equivalent by
 * one shared contract suite, with one asymmetry: only its `account` scope has
 * an HTTP backend, because `device` values never leave the device. The
 * `AssetProvider` ships its browser backend only; its server design is being
 * reworked around a global resource pool (#1007), so no HTTP backend is exposed
 * here.
 */
export type { DeviceSafeKVStore, KVScope, KVStore, LocalKVStore } from './kv/types.js';
export { assertKVScope, DEFAULT_KV_SCOPE, KVScopeViolationError } from './kv/types.js';
export { BrowserKVStore, type BrowserKVStoreOptions } from './kv/browser.js';
export {
  HttpAccountKV,
  HttpKVStore,
  HttpKVStoreError,
  type AccountScope,
  type HttpAccountKVOptions,
  type HttpKVHeadersContext,
  type HttpKVHeadersHook,
  type HttpKVStoreOptions,
} from './kv/http.js';
export { BrowserAssetProvider, type BrowserAssetProviderOptions } from './asset/browser.js';

export {
  kvPersistStorage,
  type PersistedValue,
  type PersistStorageLike,
} from './zustand/persist.js';

export type {
  DocumentStore,
  MaicDocument,
  DocumentSummary,
  SceneLike,
  SceneValidator,
  StageValidator,
} from './document/types.js';
export { DocumentNotFoundError, DocumentVersionError } from './document/types.js';
export { BrowserDocumentStore, type BrowserDocumentStoreOptions } from './document/browser.js';
export {
  HttpDocumentStore,
  HttpDocumentStoreError,
  type HttpDocumentHeadersContext,
  type HttpDocumentHeadersHook,
  type HttpDocumentStoreOptions,
} from './document/http.js';
export {
  PgDocumentStore,
  DOCUMENT_PG_SCHEMA,
  ensureDocumentSchema,
  type PgDocumentStoreOptions,
} from './document/pg.js';

export type {
  RuntimeStore,
  RuntimeSessionInit,
  RuntimePayloadValidator,
  RuntimeAppendOptions,
  RuntimeTailOptions,
} from './runtime/types.js';
export { RuntimeAppendConflictError } from './runtime/types.js';
export { BrowserRuntimeStore, type BrowserRuntimeStoreOptions } from './runtime/browser.js';

// Re-export the DSL-owned asset contract for convenience, so consumers can get
// the interface and a backend from one import without reaching into the DSL.
export type { AssetRef, AssetMeta, BinaryBlob, StorageProvider } from '@openmaic/dsl';
