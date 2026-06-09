// The slide object model is the canonical contract from @maic/dsl. The renderer
// no longer vendors its own copy; it re-exports the DSL types here so the public
// `@maic/renderer/types` surface stays intact.
export * from '@maic/dsl';
export * from './effects';
