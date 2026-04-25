import { detectCodeLanguage, type CodeLanguage } from './languages.js';
import { parseCodeWithTreeSitter } from './treeSitter.js';
import type Parser from 'web-tree-sitter';

export type CodeSymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'struct'
  | 'impl'
  | 'constant'
  | 'module'
  | 'unknown';

export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  language: CodeLanguage;
  startLine: number;
  endLine: number;
  signature?: string | undefined;
  docstring?: string | undefined;
  imports?: string[] | undefined;
  path?: string | undefined;
}

interface TreeSitterSymbolSpec {
  node: Parser.SyntaxNode;
  name: string;
  kind: CodeSymbolKind;
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function trimCommentLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function extractImports(lines: string[], language: CodeLanguage): string[] {
  switch (language) {
    case 'python':
      return trimCommentLines(
        lines.filter((line) => /^\s*(?:from\s+\S+\s+import\s+|import\s+)/u.test(line)),
      );
    case 'go':
      return trimCommentLines(lines.filter((line) => /^\s*import\s+(?:\(|"|`)/u.test(line)));
    case 'rust':
      return trimCommentLines(lines.filter((line) => /^\s*use\s+/u.test(line)));
    case 'typescript':
    case 'javascript':
      return trimCommentLines(
        lines.filter((line) => /^\s*(?:import\s+.+from\s+|import\s+['"]).+/u.test(line)),
      );
    default:
      return [];
  }
}

function extractLeadingDocstring(lines: string[], startLine: number): string | undefined {
  const previousIndex = startLine - 2;
  if (previousIndex < 0 || previousIndex >= lines.length) return undefined;
  const previous = lines[previousIndex];
  if (previous === undefined) return undefined;

  const trimmed = previous.trim();
  if (trimmed.startsWith('/**') || trimmed.startsWith('/*') || trimmed.startsWith('//')) {
    const block: string[] = [];
    for (let index = startLine - 2; index >= 0; index--) {
      const line = lines[index];
      if (line === undefined) break;
      const clean = line.trim();
      if (clean.length === 0) break;
      if (
        clean.startsWith('//') ||
        clean.startsWith('/*') ||
        clean.startsWith('*') ||
        clean.startsWith('/**')
      ) {
        block.unshift(clean);
        continue;
      }
      break;
    }
    const text = normalizeLine(block.join(' '));
    return text.length > 0 ? text : undefined;
  }

  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
    return trimmed;
  }

  return undefined;
}

function extractPythonBodyDocstring(node: Parser.SyntaxNode): string | undefined {
  const body = node.childForFieldName('body');
  const first = body?.namedChild(0);
  const text = first?.text?.trim();
  if (text === undefined) return undefined;
  return text.startsWith('"""') || text.startsWith("'''") ? normalizeLine(text) : undefined;
}

function signatureFromNode(node: Parser.SyntaxNode): string {
  const firstLine = node.text.split(/\r?\n/u, 1)[0] ?? node.text;
  return normalizeLine(firstLine);
}

function matchSymbolHeader(
  line: string,
  language: CodeLanguage,
): { name: string; kind: CodeSymbolKind; signature: string } | null {
  switch (language) {
    case 'typescript':
    case 'javascript': {
      const classMatch = /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (classMatch?.[1] !== undefined) {
        return { name: classMatch[1], kind: 'class', signature: normalizeLine(line) };
      }

      const functionMatch = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(
        line,
      );
      if (functionMatch?.[1] !== undefined) {
        return { name: functionMatch[1], kind: 'function', signature: normalizeLine(line) };
      }

      const constMatch =
        /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=>/u.exec(
          line,
        );
      if (constMatch?.[1] !== undefined) {
        return { name: constMatch[1], kind: 'constant', signature: normalizeLine(line) };
      }

      const methodMatch =
        /^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{}]+)?\s*\{/u.exec(line);
      if (methodMatch?.[1] !== undefined) {
        return { name: methodMatch[1], kind: 'method', signature: normalizeLine(line) };
      }

      return null;
    }

    case 'python': {
      const classMatch = /^\s*class\s+([A-Za-z_][\w]*)/u.exec(line);
      if (classMatch?.[1] !== undefined) {
        return { name: classMatch[1], kind: 'class', signature: normalizeLine(line) };
      }

      const functionMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/u.exec(line);
      if (functionMatch?.[1] !== undefined) {
        return { name: functionMatch[1], kind: 'function', signature: normalizeLine(line) };
      }

      return null;
    }

    case 'go': {
      const typeMatch = /^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/u.exec(line);
      if (typeMatch?.[1] !== undefined) {
        return { name: typeMatch[1], kind: 'struct', signature: normalizeLine(line) };
      }

      const funcMatch = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/u.exec(line);
      if (funcMatch?.[1] !== undefined) {
        return { name: funcMatch[1], kind: 'function', signature: normalizeLine(line) };
      }

      return null;
    }

    case 'rust': {
      const structMatch = /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/u.exec(line);
      if (structMatch?.[1] !== undefined) {
        return { name: structMatch[1], kind: 'struct', signature: normalizeLine(line) };
      }

      const implMatch = /^\s*impl\s+([A-Za-z_][\w:]*)/u.exec(line);
      if (implMatch?.[1] !== undefined) {
        return { name: implMatch[1], kind: 'impl', signature: normalizeLine(line) };
      }

      const fnMatch = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/u.exec(line);
      if (fnMatch?.[1] !== undefined) {
        return { name: fnMatch[1], kind: 'function', signature: normalizeLine(line) };
      }

      return null;
    }

    default:
      return null;
  }
}

function nameFromField(node: Parser.SyntaxNode, fieldName = 'name'): string | undefined {
  const name = node.childForFieldName(fieldName)?.text.trim();
  return name !== undefined && name.length > 0 ? name : undefined;
}

function nameFromGoTypeDeclaration(node: Parser.SyntaxNode): string | undefined {
  const spec = node.namedChildren.find((child) => child.type === 'type_spec');
  return spec?.childForFieldName('name')?.text.trim();
}

function symbolSpecFromNode(
  node: Parser.SyntaxNode,
  language: CodeLanguage,
): TreeSitterSymbolSpec | undefined {
  switch (language) {
    case 'typescript':
    case 'javascript': {
      if (node.type === 'class_declaration') {
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'class' };
      }
      if (node.type === 'function_declaration') {
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'function' };
      }
      if (node.type === 'method_definition') {
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'method' };
      }
      if (node.type === 'variable_declarator') {
        const valueType = node.childForFieldName('value')?.type;
        if (valueType !== 'arrow_function' && valueType !== 'function') return undefined;
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'constant' };
      }
      return undefined;
    }
    case 'python': {
      if (node.type === 'class_definition') {
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'class' };
      }
      if (node.type === 'function_definition') {
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'function' };
      }
      return undefined;
    }
    case 'go': {
      if (node.type === 'type_declaration') {
        const name = nameFromGoTypeDeclaration(node);
        return name === undefined ? undefined : { node, name, kind: 'struct' };
      }
      if (node.type === 'function_declaration') {
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'function' };
      }
      if (node.type === 'method_declaration') {
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'method' };
      }
      return undefined;
    }
    case 'rust': {
      if (node.type === 'struct_item') {
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'struct' };
      }
      if (node.type === 'impl_item') {
        const typeName = node.childForFieldName('type')?.text.trim();
        return typeName === undefined ? undefined : { node, name: typeName, kind: 'impl' };
      }
      if (node.type === 'function_item') {
        const name = nameFromField(node);
        return name === undefined ? undefined : { node, name, kind: 'function' };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function collectSymbolSpecs(
  node: Parser.SyntaxNode,
  language: CodeLanguage,
  specs: TreeSitterSymbolSpec[],
): void {
  const spec = symbolSpecFromNode(node, language);
  if (spec !== undefined) specs.push(spec);
  for (const child of node.namedChildren) collectSymbolSpecs(child, language, specs);
}

export function extractCodeSymbols(
  content: string,
  language: CodeLanguage,
  path?: string,
): CodeSymbol[] {
  const resolvedLanguage =
    language === 'unknown' ? detectCodeLanguage(path ?? '', content) : language;
  if (resolvedLanguage === 'unknown') return [];

  const lines = content.split(/\r?\n/u);
  const imports = extractImports(lines, resolvedLanguage);
  const matches: CodeSymbol[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;

    const header = matchSymbolHeader(line, resolvedLanguage);
    if (header === null) continue;

    matches.push({
      name: header.name,
      kind: header.kind,
      language: resolvedLanguage,
      startLine: index + 1,
      endLine: index + 1,
      signature: header.signature,
      docstring: extractLeadingDocstring(lines, index + 1),
      imports: imports.length > 0 ? imports : undefined,
      path,
    });
  }

  if (matches.length === 0) return [];

  matches.sort((left, right) => left.startLine - right.startLine);
  for (let index = 0; index < matches.length; index++) {
    const current = matches[index];
    const next = matches[index + 1];
    if (current === undefined) continue;
    current.endLine =
      next === undefined ? lines.length : Math.max(current.startLine, next.startLine - 1);
  }

  return matches;
}

export async function extractCodeSymbolsWithTreeSitter(
  content: string,
  language: CodeLanguage,
  path?: string,
): Promise<CodeSymbol[]> {
  const resolvedLanguage =
    language === 'unknown' ? detectCodeLanguage(path ?? '', content) : language;
  if (resolvedLanguage === 'unknown') return [];

  const parsed = await parseCodeWithTreeSitter(content, resolvedLanguage);
  if (parsed === null || parsed.rootNode.hasError()) {
    return extractCodeSymbols(content, resolvedLanguage, path);
  }

  const lines = content.split(/\r?\n/u);
  const imports = extractImports(lines, resolvedLanguage);
  const specs: TreeSitterSymbolSpec[] = [];
  collectSymbolSpecs(parsed.rootNode, resolvedLanguage, specs);

  return specs
    .map(({ node, name, kind }) => {
      const startLine = node.startPosition.row + 1;
      const bodyDocstring =
        resolvedLanguage === 'python' ? extractPythonBodyDocstring(node) : undefined;
      return {
        name,
        kind,
        language: resolvedLanguage,
        startLine,
        endLine: node.endPosition.row + 1,
        signature: signatureFromNode(node),
        docstring: bodyDocstring ?? extractLeadingDocstring(lines, startLine),
        imports: imports.length > 0 ? imports : undefined,
        path,
      } satisfies CodeSymbol;
    })
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
}
