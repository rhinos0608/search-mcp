/**
 * Destination-class catalog for indexed discovery query constraints.
 *
 * Host lists are filter intent only. They never prove publisher identity.
 * Informational policy on a destination class never authorizes direct access.
 */
export const SEEK_DESTINATION_CLASS = {
  id: 'board:seek',
  targetKind: 'board',
  // query constraint only — NEVER publisher proof
  includeDomains: ['seek.com.au', 'www.seek.com.au', 'au.seek.com'],
} as const;

export type DestinationClassId = typeof SEEK_DESTINATION_CLASS.id;

/** Exa/Tavily accept includeDomains. Brave and others do not — omit class slices. */
export function supportsIndexedDomainFilter(providerId: string): boolean {
  return providerId === 'search-provider:exa' || providerId === 'search-provider:tavily';
}
