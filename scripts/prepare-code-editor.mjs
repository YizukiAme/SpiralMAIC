// Serve Monaco from this installation; project source never needs an editor CDN.
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const monacoRoot = dirname(require.resolve('monaco-editor/package.json'));
const destination = resolve(import.meta.dirname, '../public/code-editor/vs');

// Monaco's prebuilt assets embed their own DOMPurify. Updating the dependency
// alone leaves that vulnerable copy in the browser, so rebuild its ESM sources.
const patchedSanitizer = {
  name: 'patched-monaco-sanitizer',
  setup(builder) {
    builder.onResolve({ filter: /[\\/]dompurify[\\/]dompurify\.js$/ }, () => ({
      path: require.resolve('dompurify'),
    }));
  },
};
const shared = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
};

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await copyFile(resolve(monacoRoot, 'min/vs/loader.js'), resolve(destination, 'loader.js'));

// Keep the AMD entry used by @monaco-editor/react, while building the editor
// and language workers with the same esbuild pipeline as our standalone player.
await build({
  ...shared,
  entryPoints: [resolve(monacoRoot, 'esm/vs/editor/editor.main.js')],
  outfile: resolve(destination, 'editor/editor.main.js'),
  globalName: 'monaco',
  plugins: [patchedSanitizer],
  loader: { '.ttf': 'file' },
  footer: {
    js: `
self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    const kind = ({ json: 'json', css: 'css', scss: 'css', less: 'css', html: 'html', handlebars: 'html', razor: 'html', typescript: 'typescript', javascript: 'typescript' })[label] || 'editor';
    return new Worker('/code-editor/vs/workers/' + kind + '.js', { name: label });
  }
};
const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = '/code-editor/vs/editor/editor.main.css';
document.head.appendChild(stylesheet);
globalThis.monaco = monaco;
define('vs/editor/editor.main', [], () => monaco);`,
  },
});

await build({
  ...shared,
  entryPoints: {
    editor: resolve(monacoRoot, 'esm/vs/editor/editor.worker.js'),
    json: resolve(monacoRoot, 'esm/vs/language/json/json.worker.js'),
    css: resolve(monacoRoot, 'esm/vs/language/css/css.worker.js'),
    html: resolve(monacoRoot, 'esm/vs/language/html/html.worker.js'),
    typescript: resolve(monacoRoot, 'esm/vs/language/typescript/ts.worker.js'),
  },
  outdir: resolve(destination, 'workers'),
});
console.log('Built deployment-hosted Monaco with the patched sanitizer.');
