import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setInstitutionalDomainsForTest,
  isInstitutionalHost,
} from '../../src/domainFacts/lookup.js';

test('exact + controlled child-host matching, no false positives', () => {
  _setInstitutionalDomainsForTest(['eosc.edu', 'anl.gov']);
  try {
    // exact
    assert.equal(isInstitutionalHost('eosc.edu'), true);
    assert.equal(isInstitutionalHost('anl.gov'), true);
    // controlled child hosts inherit
    assert.equal(isInstitutionalHost('www.eosc.edu'), true);
    assert.equal(isInstitutionalHost('labs.eosc.edu'), true);
    assert.equal(isInstitutionalHost('deep.anl.gov'), true);
    // normalization: www/case/trailing dot
    assert.equal(isInstitutionalHost('WWW.Eosc.edu.'), true);
    // no parent / sibling / suffix false positives
    assert.equal(isInstitutionalHost('eosc.edu.evil.com'), false);
    assert.equal(isInstitutionalHost('notanl.gov'), false);
    assert.equal(isInstitutionalHost('anl.gov.evil.com'), false);
    assert.equal(isInstitutionalHost('anl2.gov'), false);
    assert.equal(isInstitutionalHost('eosc'), false);
    assert.equal(isInstitutionalHost(''), false);
    assert.equal(isInstitutionalHost('co.uk'), false);
  } finally {
    _setInstitutionalDomainsForTest([]);
  }
});
