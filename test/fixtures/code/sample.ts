import fs from 'node:fs';

/** Service for sample retrieval. */
export class SampleService {
  constructor(private readonly prefix: string) {}

  buildMessage(name: string): string {
    return formatName(this.prefix, name);
  }
}

export function formatName(prefix: string, name: string): string {
  function normalize(input: string): string {
    return input.trim().toLowerCase();
  }

  const cleaned = normalize(name);
  return `${prefix}:${cleaned}`;
}

export const combine = (left: string, right: string): string => {
  return formatName(left, right);
};

void fs.existsSync;
