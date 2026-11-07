import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { editor as MonacoEditor } from 'monaco-editor';

type Monaco = typeof import('monaco-editor');
type EditorProbe = { monaco: Monaco; editor: MonacoEditor.IStandaloneCodeEditor };

// Like the other browser contracts, opt in when Chromium is installed.
describe.skipIf(process.env.CODE_EDITOR_BROWSER !== '1')(
  'deployment-hosted Monaco in Chromium',
  () => {
    let server: Server;
    let browser: Browser;
    let origin: string;

    beforeAll(async () => {
      const fixture = await build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import Editor, { loader } from '@monaco-editor/react';
loader.config({ paths: { vs: '/code-editor/vs' } });
createRoot(document.getElementById('editor')).render(React.createElement(Editor, {
  height: '400px', defaultLanguage: 'typescript', defaultValue: 'const count: number = 1;',
  onMount(editor, monaco) { window.editorProbe = { editor, monaco }; }
}));`,
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        format: 'iife',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      server = createServer(async (request, response) => {
        if (request.url === '/') {
          response.setHeader('content-type', 'text/html');
          response.end('<!doctype html><div id="editor"></div><script src="/fixture.js"></script>');
        } else if (request.url === '/fixture.js') {
          response.setHeader('content-type', 'text/javascript');
          response.end(fixture.outputFiles[0].contents);
        } else {
          try {
            const path = request.url!.split('?')[0];
            response.setHeader(
              'content-type',
              path.endsWith('.css') ? 'text/css' : 'text/javascript',
            );
            response.end(await readFile(join(process.cwd(), 'public', path)));
          } catch {
            response.writeHead(404).end();
          }
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch();
    }, 30_000);

    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    });

    it('loads through the React wrapper, edits text, and runs local language workers', async () => {
      const page = await browser.newPage();
      const errors: string[] = [];
      const requests: string[] = [];
      const workers: string[] = [];
      page.on('worker', (worker) => workers.push(worker.url()));
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => requests.push(request.url()));
      await page.goto(origin);
      await page.waitForFunction(() =>
        Boolean((window as Window & { editorProbe?: EditorProbe }).editorProbe),
      );
      const result = await page.evaluate(async () => {
        const { editor, monaco } = (window as Window & { editorProbe?: EditorProbe }).editorProbe!;
        editor.setPosition({ lineNumber: 1, column: editor.getModel()!.getLineMaxColumn(1) });
        editor.trigger('test', 'type', { text: '\nconst title: string = 2;' });
        const model = editor.getModel()!;
        const tsWorker = await (await monaco.typescript.getTypeScriptWorker())(model.uri);
        const diagnostics = await tsWorker.getSemanticDiagnostics(model.uri.toString());
        monaco.editor.createModel('{broken}', 'json', monaco.Uri.parse('file:///probe.json'));
        monaco.editor.createModel(
          'a { color: red; }',
          'css',
          monaco.Uri.parse('file:///probe.css'),
        );

        monaco.editor.createModel(
          '<html><body><div>text</div></body></html>',
          'html',
          monaco.Uri.parse('file:///probe.html'),
        );

        const diffHost = document.createElement('div');
        document.body.appendChild(diffHost);
        const diff = monaco.editor.createDiffEditor(diffHost);
        const diffReady = new Promise<void>((resolve) => diff.onDidUpdateDiff(() => resolve()));
        diff.setModel({
          original: monaco.editor.createModel('before'),
          modified: monaco.editor.createModel('after'),
        });
        await diffReady;
        return {
          value: model.getValue(),
          typescriptError: diagnostics.some((diagnostic) => diagnostic.code === 2322),
          diffChanges: diff.getLineChanges()!.length,
          width: editor.getDomNode()!.clientWidth,
        };
      });
      expect(result.value).toContain('const title: string = 2;');
      expect(result.typescriptError).toBe(true);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const { monaco } = (window as Window & { editorProbe?: EditorProbe }).editorProbe!;
            return monaco.editor.getModelMarkers({
              resource: monaco.Uri.parse('file:///probe.json'),
            }).length;
          }),
        )
        .toBeGreaterThan(0);
      for (const extension of ['css', 'html']) {
        await expect
          .poll(() =>
            page.evaluate(async (extension) => {
              const { editor, monaco } = (window as Window & { editorProbe?: EditorProbe })
                .editorProbe!;
              editor.setModel(
                monaco.editor.getModel(monaco.Uri.parse(`file:///probe.${extension}`)),
              );
              await editor.getAction('editor.action.formatDocument')!.run();
              return editor.getValue();
            }, extension),
          )
          .toContain('\n');
      }
      expect(result.diffChanges).toBeGreaterThan(0);
      for (const kind of ['editor', 'json', 'css', 'html', 'typescript']) {
        expect(workers).toContain(`${origin}/code-editor/vs/workers/${kind}.js`);
      }
      expect(result.width).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      expect(requests.every((url) => url.startsWith(origin))).toBe(true);
      await page.close();
    }, 30_000);
  },
);
