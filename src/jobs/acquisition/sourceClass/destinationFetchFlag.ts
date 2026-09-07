/**
 * W4 destination fetch consultation.
 *
 * Returns DESTINATION_FETCH_CAPABILITY only when global flag true.
 * Capability presence never authorizes work. Existing exact policy and
 * executeIfPolicyPermitted() remain required. Per-source flag also required.
 */
import { DESTINATION_FETCH_CAPABILITY } from '../destinationFetch.js';
import type { AdapterCapability } from '../adapterCapability.js';
import type { JobsAcquisitionConfig } from './contracts.js';

/**
 * Returns [DESTINATION_FETCH_CAPABILITY] when global flag is true, otherwise [].
 * The caller must still check per-source flags and executeIfPolicyPermitted().
 */
export function destinationFetchCapabilities(
  config: JobsAcquisitionConfig,
): readonly AdapterCapability[] {
  return config.destinationFetchEnabled ? [DESTINATION_FETCH_CAPABILITY] : [];
}
