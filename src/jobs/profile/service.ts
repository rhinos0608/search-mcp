import {
  ProfileCapabilityReportSchema,
  ProfileInputSchema,
  ProfileMinimizationResultSchema,
  type ProfileCapabilityReport,
  type ProfileMinimizationResult,
} from './contracts.js';
import { minimizeProfile } from './minimize.js';
import { readTrustedProfileFile, type ProfileReaderFileSystem } from './reader.js';

export interface ProcessProfileRequestOptions {
  allowedTermRefs: ReadonlySet<string>;
  trustedRoots?: readonly string[];
  maxBytes?: number;
  fileSystem?: ProfileReaderFileSystem;
}

function deepFreeze<T extends object>(value: T): T {
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const prop = (value as Record<string, unknown>)[key];
      if (prop !== null && typeof prop === 'object') {
        deepFreeze(prop);
      }
    }
  }
  return value;
}

export const PROFILE_CAPABILITY_REPORT: ProfileCapabilityReport = deepFreeze(
  ProfileCapabilityReportSchema.parse({
    capabilities: [
      { inputKind: 'structured_profile', ingestion: 'supported', minimization: 'supported' },
      {
        inputKind: 'inline_text',
        ingestion: 'supported',
        minimization: 'requires_vetted_extractor',
      },
      {
        inputKind: 'trusted_root_file',
        ingestion: 'supported',
        minimization: 'requires_vetted_extractor',
      },
    ],
    zeroPersistence: true,
    reusableHandle: false,
    binaryFiles: false,
    urlIngestion: false,
  }),
);

function invalidInput(): ProfileMinimizationResult {
  return ProfileMinimizationResultSchema.parse({
    status: 'rejected',
    code: 'INVALID_PROFILE_INPUT',
    warnings: ['invalid_profile_input'],
  });
}

function requiresExtractor(
  inputKind: 'inline_text' | 'trusted_root_file',
): ProfileMinimizationResult {
  return ProfileMinimizationResultSchema.parse({
    status: 'requires_extractor',
    inputKind,
    code: 'VETTED_EXTRACTOR_REQUIRED',
    rawRetained: false,
    warnings: ['free_text_extraction_unavailable'],
  });
}

function isReadonlySetLike(value: unknown): value is ReadonlySet<string> {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { has?: unknown }).has === 'function'
    );
  } catch {
    return false;
  }
}

export async function processProfileRequest(
  input: unknown,
  options: ProcessProfileRequestOptions,
): Promise<ProfileMinimizationResult> {
  let allowed: ReadonlySet<string>;
  try {
    const candidate = (options as { allowedTermRefs?: unknown } | null | undefined)
      ?.allowedTermRefs;
    if (!isReadonlySetLike(candidate)) {
      return invalidInput();
    }
    allowed = candidate;
  } catch {
    return invalidInput();
  }

  const parsed = ProfileInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput();
  }

  const data = parsed.data;

  if (data.kind === 'structured_profile') {
    try {
      return minimizeProfile(data, { allowedTermRefs: allowed });
    } catch {
      return invalidInput();
    }
  }

  if (data.kind === 'inline_text') {
    return requiresExtractor('inline_text');
  }

  // trusted_root_file
  try {
    const readerOptions: {
      trustedRoots: readonly string[];
      maxBytes?: number;
      fileSystem?: ProfileReaderFileSystem;
    } = {
      trustedRoots: options.trustedRoots ?? [],
    };
    if (options.maxBytes !== undefined) readerOptions.maxBytes = options.maxBytes;
    if (options.fileSystem !== undefined) readerOptions.fileSystem = options.fileSystem;
    const file = await readTrustedProfileFile(data, readerOptions);

    if (
      file.metadata.contentType !== data.contentType ||
      file.metadata.sizeBytes !== data.sizeBytes
    ) {
      return invalidInput();
    }

    // discard request-locally
    void file.content;

    return requiresExtractor('trusted_root_file');
  } catch {
    return invalidInput();
  }
}
