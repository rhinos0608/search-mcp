/**
 * Mock HTTP responses for academic search backend tests.
 * Each backend has a specific response format. These mocks return
 * minimal valid data so tests can verify function behavior without
 * real outbound HTTP calls.
 */

/** Crossref: returns { message: { items: [...] } } */
export function crossrefMockResponse() {
  return new Response(JSON.stringify({
    message: {
      items: [{ title: ['Test Paper'], DOI: '10.1234/test', URL: 'https://doi.org/10.1234/test' }],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** DataCite: returns { data: [...] } */
export function dataciteMockResponse() {
  return new Response(JSON.stringify({
    data: [{ id: '10.1234/test', attributes: { title: 'Test Dataset', url: 'https://doi.org/10.1234/test' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** OpenAlex: returns { results: [...] } */
export function openalexMockResponse() {
  return new Response(JSON.stringify({
    results: [{ id: 'W123', title: 'Test Work', doi: 'https://doi.org/10.1234/test' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** ROR: returns { items: [...] } */
export function rorMockResponse() {
  return new Response(JSON.stringify({
    items: [{ id: 'https://ror.org/123', name: 'Test University', links: ['https://test.edu'] }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Wikidata: returns { search: [...] } */
export function wikidataMockResponse() {
  return new Response(JSON.stringify({
    search: [{ id: 'Q123', label: 'Test Entity', description: 'A test entity' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
