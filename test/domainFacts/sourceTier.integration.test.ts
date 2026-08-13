import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDomainAuthority,
  getSourceBasis,
  getSourceQuality,
} from '../../src/utils/sourceTier.js';
import { _setInstitutionalDomainsForTest } from '../../src/domainFacts/lookup.js';
import { INSTITUTIONAL_DOMAINS } from '../../src/domainFacts/registry.generated.js';
import { INSTITUTIONAL_SCORE, INSTITUTIONAL_BASIS } from '../../src/domainFacts/types.js';

function withDomains(domains: string[], fn: () => void): void {
  _setInstitutionalDomainsForTest(domains);
  try {
    fn();
  } finally {
    _setInstitutionalDomainsForTest(INSTITUTIONAL_DOMAINS);
  }
}

test('manual explicit/curated/platform-low rules stay highest priority over ROR promotion', () => {
  withDomains(['wikipedia.org', 'youtube.com', 'nature.com'], () => {
    assert.equal(getDomainAuthority('wikipedia.org'), 0.85, 'explicit wins');
    assert.equal(getDomainAuthority('www.wikipedia.org'), 0.85, 'explicit wins on www');
    assert.equal(getDomainAuthority('youtube.com'), 0.3, 'platform-low wins');
    assert.equal(getDomainAuthority('nature.com'), 0.85, 'curated wins');
  });
});

test('ROR education domains promote to institutional 0.70 with academic basis', () => {
  withDomains(['eosc.edu', 'exampleuni.io', 'exampleuni.dev'], () => {
    assert.equal(getDomainAuthority('eosc.edu'), 0.7);
    assert.equal(getDomainAuthority('sub.eosc.edu'), 0.7, 'child host inherits');
    assert.equal(getDomainAuthority('exampleuni.io'), 0.7, 'promoted from .io');
    assert.equal(getDomainAuthority('exampleuni.dev'), 0.7, 'promoted from .dev');
    assert.equal(getSourceBasis('exampleuni.io'), 'academic domain');
    assert.equal(getSourceBasis('sub.eosc.edu'), 'academic domain');
  });
});

test('government/academic suffix tiers keep their existing scores (no lowering)', () => {
  withDomains(['ox.ac.uk', 'mit.edu', 'nist.gov'], () => {
    assert.equal(getDomainAuthority('ox.ac.uk'), 0.75, '.ac.uk keeps 0.75');
    assert.equal(getDomainAuthority('mit.edu'), 0.7, '.edu keeps 0.7');
    assert.equal(getDomainAuthority('nist.gov'), 0.85, '.gov keeps 0.85');
  });
});

test('second-level government ccTLDs score as government, not the generic default', () => {
  withDomains(['rba.gov.au', 'unimelb.edu.au'], () => {
    // A central bank on gov.au must not flatten to the 0.4 low default.
    assert.equal(getDomainAuthority('rba.gov.au'), 0.85, 'gov.au is government tier');
    assert.equal(getSourceQuality('rba.gov.au'), 'high', 'gov.au labeled high, not low');
    assert.equal(getSourceBasis('rba.gov.au'), 'government domain');
    assert.equal(getDomainAuthority('data.gov.sg'), 0.85, 'gov.sg is government tier');
    assert.equal(getDomainAuthority('mod.mil.uk'), 0.85, 'mil.uk is government tier');
    // Education second-level ccTLDs mirror the .edu academic tier.
    assert.equal(getDomainAuthority('unimelb.edu.au'), 0.7, 'edu.au is academic tier');
    assert.equal(getSourceBasis('unimelb.edu.au'), 'academic domain');
    // A 3-letter second level is not a ccTLD gov and stays generic.
    assert.equal(getDomainAuthority('foo.gov.com'), 0.4, 'gov.com is not a government ccTLD');
  });
});

test('no false promotion from real non-education ROR facts', () => {
  // Restore the real generated institutional set.
  _setInstitutionalDomainsForTest(INSTITUTIONAL_DOMAINS);
  // anl.gov (facility) and eosc.eu (nonprofit) are ROR facts but must NOT be promoted.
  assert.equal(getDomainAuthority('anl.gov'), 0.85, 'gov official wins over ROR facility');
  assert.notEqual(getDomainAuthority('eosc.eu'), INSTITUTIONAL_SCORE);
  assert.equal(getSourceBasis('eosc.eu'), null);
});

test('no ranking weight changes — baseline values preserved', () => {
  _setInstitutionalDomainsForTest(INSTITUTIONAL_DOMAINS);
  const baseline: Record<string, number> = {
    'ieee.org': 0.9,
    'acm.org': 0.9,
    'arxiv.org': 0.9,
    'nature.com': 0.85,
    'github.com': 0.8,
    'reddit.com': 0.4,
    'youtube.com': 0.3,
    'blog.blogspot.com': 0.2,
    'mydomain.com': 0.4,
    'student.example.edu': 0.7,
    'ox.ac.uk': 0.75,
    'nist.gov': 0.85,
    'gov.uk': 0.85,
  };
  for (const [domain, expected] of Object.entries(baseline)) {
    assert.equal(getDomainAuthority(domain), expected, `${domain} unchanged`);
  }
});

test('INSTITUTIONAL_SCORE equals the existing .edu institutional tier', () => {
  _setInstitutionalDomainsForTest(INSTITUTIONAL_DOMAINS);
  assert.equal(INSTITUTIONAL_SCORE, 0.7);
  assert.equal(INSTITUTIONAL_BASIS, 'academic domain');
  assert.equal(getDomainAuthority('someuniv.edu'), 0.7, '.edu suffix unchanged');
});
