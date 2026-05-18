export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

export function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    if (fenceMatch[1]) candidates.push(fenceMatch[1]);
  }

  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== '{' && first !== '[') continue;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}' || char === ']') {
        if (stack.at(-1) !== char) break;
        stack.pop();
        if (stack.length === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

export function parseJsonFromText(text: string): unknown {
  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;

  for (const candidate of extractJsonCandidates(text)) {
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}
