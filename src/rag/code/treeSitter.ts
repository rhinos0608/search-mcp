import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import type { CodeLanguage } from './languages.js';

const require = createRequire(import.meta.url);

const TREE_SITTER_WASM_PATH = require.resolve('web-tree-sitter/tree-sitter.wasm');

const LANGUAGE_WASM_PATHS: Partial<Record<CodeLanguage, string>> = {
  typescript: require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'),
  javascript: require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm'),
  python: require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'),
  go: require.resolve('tree-sitter-wasms/out/tree-sitter-go.wasm'),
  rust: require.resolve('tree-sitter-wasms/out/tree-sitter-rust.wasm'),
  json: require.resolve('tree-sitter-wasms/out/tree-sitter-json.wasm'),
  yaml: require.resolve('tree-sitter-wasms/out/tree-sitter-yaml.wasm'),
  shell: require.resolve('tree-sitter-wasms/out/tree-sitter-bash.wasm'),
};

export interface TreeSitterParserHandle {
  language: CodeLanguage;
  parser: Parser;
}

export interface ParsedTreeSitterCode {
  language: CodeLanguage;
  rootType: string;
  rootNode: Parser.SyntaxNode;
  tree: Parser.Tree;
}

let initPromise: Promise<void> | undefined;
let treeSitterGeneration = 0;
const languagePromises = new Map<CodeLanguage, Promise<Parser.Language>>();
const parserHandles = new Map<CodeLanguage, TreeSitterParserHandle>();

function initTreeSitter(): Promise<void> {
  initPromise ??= Parser.init({
    locateFile(scriptName: string) {
      return scriptName === 'tree-sitter.wasm' ? TREE_SITTER_WASM_PATH : scriptName;
    },
  });
  return initPromise;
}

async function loadLanguage(language: CodeLanguage): Promise<Parser.Language | null> {
  const generation = treeSitterGeneration;
  const wasmPath = LANGUAGE_WASM_PATHS[language];
  if (wasmPath === undefined) return null;

  await initTreeSitter();
  if (generation !== treeSitterGeneration) return null;

  let promise = languagePromises.get(language);
  if (promise === undefined) {
    promise = Parser.Language.load(wasmPath);
    languagePromises.set(language, promise);
  }
  const parserLanguage = await promise;
  if (generation !== treeSitterGeneration) return null;
  return parserLanguage;
}

/**
 * Lazily load and cache a parser for the requested language. Unsupported
 * languages return null so callers can fall back to text chunking.
 */
export async function loadTreeSitterParser(
  language: CodeLanguage,
): Promise<TreeSitterParserHandle | null> {
  const cached = parserHandles.get(language);
  if (cached !== undefined) return cached;

  const generation = treeSitterGeneration;
  const parserLanguage = await loadLanguage(language);
  if (parserLanguage === null || generation !== treeSitterGeneration) return null;

  const parser = new Parser();
  parser.setLanguage(parserLanguage);
  if (generation !== treeSitterGeneration) {
    parser.delete();
    return null;
  }

  const handle: TreeSitterParserHandle = { language, parser };
  parserHandles.set(language, handle);
  return handle;
}

export async function parseCodeWithTreeSitter(
  content: string,
  language: CodeLanguage,
): Promise<ParsedTreeSitterCode | null> {
  const handle = await loadTreeSitterParser(language);
  if (handle === null) return null;

  const tree = handle.parser.parse(content);
  return {
    language: handle.language,
    rootType: tree.rootNode.type,
    rootNode: tree.rootNode,
    tree,
  };
}

export function getLoadedTreeSitterLanguages(): CodeLanguage[] {
  return [...parserHandles.keys()].sort();
}

export function resetTreeSitterParsersForTests(): void {
  treeSitterGeneration += 1;
  initPromise = undefined;
  for (const handle of parserHandles.values()) {
    handle.parser.delete();
  }
  parserHandles.clear();
  languagePromises.clear();
}
