import { isToolError } from '../errors.js';

/** Privacy-safe telemetry for search inputs: counts and lengths only. */
export interface JobTelemetryFields {
  queryLength?: number;
  locationCount?: number;
  locationLength?: number;
}

export function jobErrorCode(error: unknown): string {
  return isToolError(error) ? error.code : 'ERROR';
}

export function jobTelemetry(input: {
  query?: string | undefined;
  location?: string | string[] | undefined;
}): JobTelemetryFields {
  const locations =
    input.location === undefined
      ? []
      : Array.isArray(input.location)
        ? input.location
        : [input.location];
  return {
    ...(input.query !== undefined ? { queryLength: input.query.length } : {}),
    ...(locations.length > 0
      ? {
          locationCount: locations.length,
          locationLength: locations.reduce((sum, value) => sum + value.length, 0),
        }
      : {}),
  };
}
