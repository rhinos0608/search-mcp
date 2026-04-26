import { chunkMarkdown } from '../../chunking.js';
import type { RagChunk, RawDocument } from '../types.js';
import { detectCodeLanguage } from '../code/languages.js';
import {
  extractCodeSymbols,
  extractCodeSymbolsWithTreeSitter,
  type CodeSymbol,
} from '../code/symbols.js';

export interface CodeFileInput {
  path: string;
  content: string;
  url: string;
}

export interface CodeChunkingOptions {
  maxLinesPerChunk?: number | undefined;
}

function fileImports(symbols: CodeSymbol[]): string[] {
  const collected = new Set<string>();
  for (const symbol of symbols) {
    for (const entry of symbol.imports ?? []) {
      collected.add(entry);
    }
  }
  return [...collected];
}

function sliceLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/u);
  const startIndex = Math.max(0, startLine - 1);
  // Validate bounds: if startLine is beyond file length, return empty string
  if (startIndex >= lines.length) return '';
  const endIndex = Math.min(lines.length, endLine);
  return lines.slice(startIndex, endIndex).join('\n').trimEnd();
}

function symbolLineWindows(
  symbol: CodeSymbol,
  maxLinesPerChunk: number,
): {
  startLine: number;
  endLine: number;
  splitIndex?: number | undefined;
  splitTotal?: number | undefined;
}[] {
  const symbolLineCount = symbol.endLine - symbol.startLine + 1;
  if (symbolLineCount <= maxLinesPerChunk) {
    return [{ startLine: symbol.startLine, endLine: symbol.endLine }];
  }

  const windows: { startLine: number; endLine: number }[] = [];
  for (
    let startLine = symbol.startLine;
    startLine <= symbol.endLine;
    startLine += maxLinesPerChunk
  ) {
    windows.push({
      startLine,
      endLine: Math.min(symbol.endLine, startLine + maxLinesPerChunk - 1),
    });
  }

  return windows.map((window, splitIndex) => ({
    ...window,
    splitIndex,
    splitTotal: windows.length,
  }));
}

function chunkSymbolsFromFile(
  file: CodeFileInput,
  symbols: CodeSymbol[],
  maxLinesPerChunk: number,
  startingChunkIndex: number,
): RagChunk[] {
  const language = detectCodeLanguage(file.path, file.content);
  const chunks: RagChunk[] = [];

  // Build window list, filtering empty slices upfront
  const validWindows: {
    symbol: CodeSymbol;
    window: {
      startLine: number;
      endLine: number;
      splitIndex?: number | undefined;
      splitTotal?: number | undefined;
    };
    text: string;
  }[] = [];
  for (const symbol of symbols) {
    const windows = symbolLineWindows(symbol, maxLinesPerChunk);
    for (const window of windows) {
      const text = sliceLines(file.content, window.startLine, window.endLine);
      if (text.length > 0) validWindows.push({ symbol, window, text });
    }
  }

  let chunkIndexCounter = startingChunkIndex;
  for (const { symbol, window, text } of validWindows) {
    chunks.push({
      text,
      url: file.url,
      section:
        window.splitIndex === undefined
          ? `${file.path} > ${symbol.name}`
          : `${file.path} > ${symbol.name} (${String(window.splitIndex + 1)}/${String(window.splitTotal)})`,
      charOffset: 0,
      chunkIndex: chunkIndexCounter++,
      totalChunks: -1, // patched after all files are processed
      metadata: {
        path: file.path,
        language,
        startLine: window.startLine,
        endLine: window.endLine,
        symbolStartLine: symbol.startLine,
        symbolEndLine: symbol.endLine,
        symbolName: symbol.name,
        symbolKind: symbol.kind,
        signature: symbol.signature,
        imports: symbol.imports,
        docstring: symbol.docstring,
        splitIndex: window.splitIndex,
        splitTotal: window.splitTotal,
      },
    });
  }

  return chunks;
}

function fallbackChunksFromFile(
  file: CodeFileInput,
  imports: string[],
  startingChunkIndex: number,
): RagChunk[] {
  const language = detectCodeLanguage(file.path, file.content);
  const fallback = chunkMarkdown(file.content, file.url);
  return fallback
    .filter((chunk) => chunk.content.length > 0)
    .map((chunk, index) => ({
      text: chunk.content,
      url: chunk.url,
      section: `${file.path} > ${chunk.section}`,
      charOffset: chunk.charOffset,
      chunkIndex: startingChunkIndex + index,
      totalChunks: -1, // patched after all files are processed
      metadata: {
        path: file.path,
        language,
        imports: imports.length > 0 ? imports : undefined,
        fallback: true,
        ...chunk.metadata,
      },
    }));
}

export function documentsFromCodeFiles(files: CodeFileInput[]): RawDocument[] {
  return files.map((file, index) => ({
    id: file.path || `code:${String(index)}`,
    adapter: 'code',
    text: file.content,
    url: file.url,
    title: file.path,
    metadata: {
      path: file.path,
      language: detectCodeLanguage(file.path, file.content),
    },
  }));
}

export function chunksFromCodeFiles(
  files: CodeFileInput[],
  options: CodeChunkingOptions = {},
): RagChunk[] {
  const chunks: RagChunk[] = [];
  const maxLinesPerChunk = options.maxLinesPerChunk ?? 120;

  for (const file of files) {
    const language = detectCodeLanguage(file.path, file.content);
    const symbols = extractCodeSymbols(file.content, language, file.path);
    const imports = fileImports(symbols);

    if (symbols.length === 0) {
      chunks.push(...fallbackChunksFromFile(file, imports, chunks.length));
      continue;
    }

    chunks.push(...chunkSymbolsFromFile(file, symbols, maxLinesPerChunk, chunks.length));
  }

  // Patch totalChunks to reflect the final corpus size
  const total = chunks.length;
  for (const chunk of chunks) {
    chunk.totalChunks = total;
  }

  return chunks;
}

export async function chunksFromCodeFilesAsync(
  files: CodeFileInput[],
  options: CodeChunkingOptions = {},
): Promise<RagChunk[]> {
  const chunks: RagChunk[] = [];
  const maxLinesPerChunk = options.maxLinesPerChunk ?? 120;

  for (const file of files) {
    const language = detectCodeLanguage(file.path, file.content);

    // Try Tree-sitter first, fall back to regex extraction on error
    let symbols: CodeSymbol[];
    try {
      symbols = await extractCodeSymbolsWithTreeSitter(file.content, language, file.path);
    } catch {
      symbols = extractCodeSymbols(file.content, language, file.path);
    }

    const imports = fileImports(symbols);

    if (symbols.length === 0) {
      chunks.push(...fallbackChunksFromFile(file, imports, chunks.length));
      continue;
    }

    chunks.push(...chunkSymbolsFromFile(file, symbols, maxLinesPerChunk, chunks.length));
  }

  // Patch totalChunks to reflect the final corpus size
  const total = chunks.length;
  for (const chunk of chunks) {
    chunk.totalChunks = total;
  }

  return chunks;
}
