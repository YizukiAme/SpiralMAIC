/**
 * Slide object-model types.
 *
 * This module is now a thin re-export of the extracted contract package
 * `@maic/dsl` — the canonical, dependency-free slide DSL that `@maic/renderer`
 * and `@maic/importer` also depend on. The hand-maintained copy that used to
 * live here was the seed for `@maic/dsl`; the app now consumes the package so
 * the three former copies can no longer drift apart.
 *
 * Import sites that previously did `from '@/lib/types/slides'` keep working
 * unchanged. New code may import from `@maic/dsl` directly.
 *
 * Note: `ShapePathFormulasKeys` and `ElementTypes` were local `const enum`s
 * here; `@maic/dsl` exposes them as regular `enum`s (a `const enum` cannot be
 * re-exported across a package boundary under `isolatedModules`). Runtime
 * value usage is identical.
 */
export * from '@maic/dsl';
