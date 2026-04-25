export type CodeLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'markdown'
  | 'json'
  | 'yaml'
  | 'shell'
  | 'unknown';

const EXTENSION_TO_LANGUAGE: Record<string, CodeLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.sh': 'shell',
  '.bash': 'shell',
};

function extensionFromPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  const lastSlash = lower.lastIndexOf('/');
  const fileName = lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;
  const lastDot = fileName.lastIndexOf('.');
  return lastDot >= 0 ? fileName.slice(lastDot) : undefined;
}

function detectFromShebang(content: string): CodeLanguage | undefined {
  const firstLine = content.split(/\r?\n/u, 1)[0] ?? '';
  if (!firstLine.startsWith('#!')) return undefined;

  if (/\bpython(?:\d+(?:\.\d+)*)?\b/u.test(firstLine)) return 'python';
  if (/\b(?:bash|sh|zsh)\b/u.test(firstLine)) return 'shell';
  if (/\bnode\b/u.test(firstLine)) return 'javascript';
  return 'shell';
}

export function detectCodeLanguage(path: string, content = ''): CodeLanguage {
  const extension = extensionFromPath(path);
  if (extension !== undefined) {
    const detected = EXTENSION_TO_LANGUAGE[extension];
    if (detected !== undefined) return detected;
  }

  const shebangDetected = detectFromShebang(content);
  if (shebangDetected !== undefined) return shebangDetected;

  return 'unknown';
}

export function isCodeLanguage(language: CodeLanguage): boolean {
  return language !== 'unknown';
}
