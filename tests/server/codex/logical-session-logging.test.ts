import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function loggerArguments(path: string): string[] {
  const sourceText = readFileSync(resolve(process.cwd(), path), 'utf8');
  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'log'
    ) {
      calls.push(node.arguments.map((argument) => argument.getText(sourceFile)).join(', '));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

describe('Codex logical session logging hygiene', () => {
  it('does not pass raw ChatSession identities to logger calls', () => {
    const unsafe = loggerArguments('components/chat/use-chat-sessions.ts').filter((argumentsText) =>
      /\bsessionId\b|\bactive\.id\b/.test(argumentsText),
    );

    expect(unsafe).toEqual([]);
  });
});
