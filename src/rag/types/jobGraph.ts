/**
 * Graph entity types for the Job Intelligence Graph.
 *
 * These types define the structured domain model for jobs, companies,
 * locations, and duplicate clusters that the JobSpy-acquisition pipeline
 * populates and the ranking layer consumes.
 */

// ── Job Posting ─────────────────────────────────────────────────────────────

export interface GraphJobPosting {
  jobId: string; // Prefixed id from jobspy (e.g. "li-12345")
  title: string;
  companyId?: string;
  locationId?: string;
  sourceSite: string; // 'linkedin', 'indeed', etc.
  sourceUrl: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryInterval?: string; // 'yearly', 'hourly', etc.
  workMode?: 'remote' | 'hybrid' | 'onsite';
  jobType?: string;
  seniority?: string;
  postedAt?: string; // ISO date YYYY-MM-DD
  description?: string;
  extractedText?: string;
  verificationStatus: 'pending' | 'verified' | 'expired' | 'suspicious';
  confidence: number; // 0-1
  caveats: string[];
}

// ── Company ────────────────────────────────────────────────────────────────

export interface GraphCompany {
  companyId: string; // Normalized (lowercase, trimmed)
  name: string;
  domain?: string;
  industry?: string;
  careersPageUrl?: string;
  logoUrl?: string;
  firstSeenAt: number; // Unix ms
  lastSeenAt: number; // Unix ms
}

// ── Location ────────────────────────────────────────────────────────────────

export interface GraphLocation {
  locationId: string; // "city-state-country" with nulls coalesced
  city?: string;
  state?: string;
  country?: string;
  displayName: string;
}

// ── Duplicate Cluster ──────────────────────────────────────────────────────

export interface GraphDuplicateCluster {
  clusterId: string; // SHA-256 hash of normalized company + title
  canonicalJobId: string; // Best-confidence job in the cluster
  memberJobIds: string[];
  memberSites: string[]; // Unique sites represented
  clusterSize: number;
  firstSeenAt: number; // Unix ms
  lastSeenAt: number; // Unix ms
}

// ── Skill ──────────────────────────────────────────────────────────────────

export interface GraphSkill {
  skillId: string;
  name: string;
  category?: string;
}

// ── Job ↔ Skill junction ───────────────────────────────────────────────────

export interface GraphJobSkill {
  jobId: string;
  skillId: string;
}
