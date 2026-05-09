/**
 * PubMed search via NCBI E-utilities.
 *
 * Free, no API key required. Uses esearch → efetch pipeline.
 * Rate limit: 3 req/sec without API key, 10 req/sec with.
 *
 * Modeled on LDR's search_engine_pubmed.py two-phase retrieval.
 */

import { safeResponseText } from '../httpGuards.js';
import { logger } from '../logger.js';

const PUBMED_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const PUBMED_EMAIL = process.env.PUBMED_EMAIL ?? 'anonymous@example.com';
const PUBMED_API_KEY = process.env.PUBMED_API_KEY;
const REQUEST_TIMEOUT_MS = 15_000;

export interface PubMedResult {
  title: string;
  link: string;
  snippet: string;
  publishedDate?: string | undefined;
  authors?: string[] | undefined;
  journal?: string | undefined;
}

/**
 * Search PubMed and return structured results with abstracts.
 */
export async function searchPubMed(query: string, limit = 10): Promise<PubMedResult[]> {
  const effectiveLimit = Math.min(Math.max(1, limit), 30);

  // ── Phase 1: ESearch — get PMIDs ────────────────────────────────────
  const esearchParams = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmax: String(effectiveLimit),
    retmode: 'json',
    sort: 'relevance',
    email: PUBMED_EMAIL,
  });
  if (PUBMED_API_KEY) esearchParams.set('api_key', PUBMED_API_KEY);

  const esearchUrl = `${PUBMED_BASE}/esearch.fcgi?${esearchParams.toString()}`;

  let esearchJson: {
    esearchresult?: {
      idlist?: string[];
    };
  };
  try {
    const esearchText = await safeResponseText(
      await fetch(esearchUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      esearchUrl,
    );
    esearchJson = JSON.parse(esearchText) as typeof esearchJson;
  } catch (err) {
    logger.warn({ err, query }, 'PubMed ESearch failed');
    return [];
  }

  const idlist = esearchJson.esearchresult?.idlist;
  if (!Array.isArray(idlist) || idlist.length === 0) {
    return [];
  }
  // ── Phase 2: EFetch — get abstracts ──────────────────────────────────
  const ids = idlist.slice(0, effectiveLimit).join(',');
  const efetchParams = new URLSearchParams({
    db: 'pubmed',
    id: ids,
    retmode: 'xml',
    email: PUBMED_EMAIL,
  });
  if (PUBMED_API_KEY) efetchParams.set('api_key', PUBMED_API_KEY);

  const efetchUrl = `${PUBMED_BASE}/efetch.fcgi?${efetchParams.toString()}`;

  let xml: string;
  try {
    xml = await safeResponseText(
      await fetch(efetchUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      efetchUrl,
    );
  } catch (err) {
    logger.warn({ err, ids }, 'PubMed EFetch failed');
    // Return title-only results from IDs
    return idlist.slice(0, effectiveLimit).map((id) => ({
      title: `PubMed ID: ${id}`,
      link: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      snippet: 'Abstract unavailable.',
    }));
  }

  return parsePubMedXml(xml).slice(0, effectiveLimit);
}

// ── XML parsing (regex-based, no parser dependency) ────────────────────

function parsePubMedXml(xml: string): PubMedResult[] {
  const results: PubMedResult[] = [];

  // Split into PubmedArticle elements
  const articleRe = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let articleMatch: RegExpExecArray | null;

  while ((articleMatch = articleRe.exec(xml)) !== null) {
    const articleXml = articleMatch[1];
    if (!articleXml) continue;

    const pmid = extractTag(articleXml, 'PMID');
    const title = extractTag(articleXml, 'ArticleTitle') ?? 'Untitled';
    const abstract = extractTag(articleXml, 'AbstractText');
    const journal = extractTag(articleXml, 'Title'); // Journal title

    // Extract authors
    const authorRe =
      /<Author[\s\S]*?<LastName>([^<]*)<\/LastName>[\s\S]*?<ForeName>([^<]*)<\/ForeName>[\s\S]*?<\/Author>/g;
    const authors: string[] = [];
    let authorMatch: RegExpExecArray | null;
    while ((authorMatch = authorRe.exec(articleXml)) !== null) {
      const last = authorMatch[1];
      const fore = authorMatch[2];
      if (last) authors.push(fore ? `${fore} ${last}` : last);
    }

    // Extract publication date
    const pubDate = extractTag(articleXml, 'PubDate');

    const snippet = abstract
      ? abstract.replace(/<[^>]*>/g, '').slice(0, 400)
      : 'No abstract available.';

    results.push({
      title: title.replace(/<[^>]*>/g, ''),
      link: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '',
      snippet,
      publishedDate: pubDate ?? undefined,
      authors: authors.length > 0 ? authors.slice(0, 5) : undefined,
      journal: journal ?? undefined,
    });
  }

  return results;
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = re.exec(xml);
  return match?.[1]?.trim() ?? null;
}
