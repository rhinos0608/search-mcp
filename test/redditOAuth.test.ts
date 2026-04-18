import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRedditClient,
  resetRedditAuthCache,
  type RedditClientOptions,
} from '../src/tools/redditClient.js';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
  const h = new Headers(init);
  return Object.fromEntries(h.entries());
}

function makeFetch(
  handler: (req: RecordedRequest) => { status: number; body: string; headers?: Record<string, string> },
): { fetchImpl: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: headersToRecord(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(req);
    const res = handler(req);
    return new Response(res.body, {
      status: res.status,
      headers: { 'content-type': 'application/json', ...(res.headers ?? {}) },
    });
  };
  return { fetchImpl, calls };
}

function makeClock(startMs = 1_000_000): {
  now: () => number;
  advance: (deltaMs: number) => void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance(deltaMs: number) {
      current += deltaMs;
    },
  };
}

afterEach(() => {
  resetRedditAuthCache();
});

test('createRedditClient uses OAuth transport (oauth.reddit.com + bearer) when auth is configured', async () => {
  const clock = makeClock();
  const { fetchImpl, calls } = makeFetch((req) => {
    if (req.url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return {
        status: 200,
        body: JSON.stringify({ access_token: 'tok-1', token_type: 'bearer', expires_in: 3600 }),
      };
    }
    return { status: 200, body: JSON.stringify({ ok: true, via: 'oauth' }) };
  });

  const options: RedditClientOptions = {
    fetchImpl,
    clock,
    auth: { clientId: 'id-xyz', clientSecret: 'secret-xyz' },
    userAgent: 'node:search-mcp:0.1.0 (by /u/tester)',
  };

  const client = createRedditClient(options);
  const json = await client.getJson('/r/typescript/comments/abc123', { sort: 'top' });

  assert.equal(client.usesOAuth(), true);
  assert.deepEqual(json, { ok: true, via: 'oauth' });

  const [tokenCall, contentCall] = calls;
  assert.ok(tokenCall !== undefined && contentCall !== undefined);

  assert.equal(tokenCall.method, 'POST');
  assert.equal(tokenCall.url, 'https://www.reddit.com/api/v1/access_token');
  assert.equal(tokenCall.body, 'grant_type=client_credentials');
  const expectedBasic = `Basic ${Buffer.from('id-xyz:secret-xyz').toString('base64')}`;
  assert.equal(tokenCall.headers['authorization'], expectedBasic);
  assert.equal(tokenCall.headers['user-agent'], 'node:search-mcp:0.1.0 (by /u/tester)');

  const parsed = new URL(contentCall.url);
  assert.equal(parsed.origin, 'https://oauth.reddit.com');
  assert.equal(parsed.pathname, '/r/typescript/comments/abc123');
  assert.equal(parsed.searchParams.get('sort'), 'top');
  assert.equal(contentCall.headers['authorization'], 'bearer tok-1');
  assert.equal(contentCall.headers['user-agent'], 'node:search-mcp:0.1.0 (by /u/tester)');
});

test('createRedditClient uses the public .json transport when no auth is configured', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, via: 'public' }) }));
  const client = createRedditClient({ fetchImpl });

  assert.equal(client.usesOAuth(), false);
  const json = await client.getJson('/r/typescript/comments/abc123');

  assert.deepEqual(json, { ok: true, via: 'public' });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call !== undefined);
  const parsed = new URL(call.url);
  assert.equal(parsed.origin, 'https://www.reddit.com');
  assert.equal(parsed.pathname, '/r/typescript/comments/abc123.json');
  assert.equal(call.headers['authorization'], undefined);
});

test('createRedditClient caches the OAuth token across successive requests', async () => {
  const clock = makeClock();
  let tokenIssued = 0;
  const { fetchImpl, calls } = makeFetch((req) => {
    if (req.url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      tokenIssued += 1;
      return {
        status: 200,
        body: JSON.stringify({
          access_token: `tok-${String(tokenIssued)}`,
          token_type: 'bearer',
          expires_in: 3600,
        }),
      };
    }
    return { status: 200, body: JSON.stringify({ ok: true }) };
  });

  const client = createRedditClient({
    fetchImpl,
    clock,
    auth: { clientId: 'id', clientSecret: 'secret' },
  });

  await client.getJson('/r/typescript/comments/abc123');
  await client.getJson('/r/typescript/comments/def456');
  await client.getJson('/r/typescript/comments/ghi789');

  assert.equal(tokenIssued, 1, 'token endpoint should only be hit once while the cached token is fresh');
  const contentCalls = calls.filter((c) => c.url.startsWith('https://oauth.reddit.com/'));
  assert.equal(contentCalls.length, 3);
  for (const c of contentCalls) {
    assert.equal(c.headers['authorization'], 'bearer tok-1');
  }
});

test('createRedditClient proactively refreshes the OAuth token when the cached token is within the safety margin', async () => {
  const clock = makeClock();
  let tokenIssued = 0;
  const { fetchImpl } = makeFetch((req) => {
    if (req.url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      tokenIssued += 1;
      return {
        status: 200,
        body: JSON.stringify({
          access_token: `tok-${String(tokenIssued)}`,
          token_type: 'bearer',
          expires_in: 120,
        }),
      };
    }
    return { status: 200, body: JSON.stringify({ ok: true }) };
  });

  const client = createRedditClient({
    fetchImpl,
    clock,
    auth: { clientId: 'id', clientSecret: 'secret' },
  });

  await client.getJson('/r/typescript/comments/abc123');
  assert.equal(tokenIssued, 1);

  clock.advance(65_000);

  await client.getJson('/r/typescript/comments/def456');
  assert.equal(tokenIssued, 2, 'expected proactive refresh within the 60s safety margin');
});

test('createRedditClient fails fast when configured-but-bad credentials are rejected by Reddit', async () => {
  const { fetchImpl } = makeFetch((req) => {
    if (req.url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return { status: 401, body: JSON.stringify({ message: 'Unauthorized', error: 401 }) };
    }
    return { status: 200, body: JSON.stringify({ ok: true }) };
  });

  const client = createRedditClient({
    fetchImpl,
    clock: makeClock(),
    auth: { clientId: 'bad', clientSecret: 'creds' },
  });

  await assert.rejects(
    () => client.getJson('/r/typescript/comments/abc123'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string; retryable?: boolean };
      assert.equal(typed.code, 'VALIDATION_ERROR');
      assert.equal(typed.retryable, false);
      assert.match(err.message, /Reddit OAuth/i);
      return true;
    },
  );
});

test('createRedditClient refuses to initialize when exactly one of clientId/clientSecret is provided', () => {
  assert.throws(
    () =>
      createRedditClient({
        auth: { clientId: 'only-id', clientSecret: '' },
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string };
      assert.equal(typed.code, 'VALIDATION_ERROR');
      return true;
    },
  );

  assert.throws(
    () =>
      createRedditClient({
        auth: { clientId: '', clientSecret: 'only-secret' },
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string };
      assert.equal(typed.code, 'VALIDATION_ERROR');
      return true;
    },
  );
});

test('createRedditClient retries a single 401 on an OAuth content call by refreshing the token', async () => {
  const clock = makeClock();
  let tokenIssued = 0;
  let contentCalls = 0;
  const { fetchImpl } = makeFetch((req) => {
    if (req.url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      tokenIssued += 1;
      return {
        status: 200,
        body: JSON.stringify({
          access_token: `tok-${String(tokenIssued)}`,
          token_type: 'bearer',
          expires_in: 3600,
        }),
      };
    }
    contentCalls += 1;
    if (contentCalls === 1) {
      return { status: 401, body: JSON.stringify({ message: 'Unauthorized', error: 401 }) };
    }
    return { status: 200, body: JSON.stringify({ ok: true }) };
  });

  const client = createRedditClient({
    fetchImpl,
    clock,
    auth: { clientId: 'id', clientSecret: 'secret' },
  });

  const json = await client.getJson('/r/typescript/comments/abc123');
  assert.deepEqual(json, { ok: true });
  assert.equal(tokenIssued, 2, 'expected a reactive token refresh after the 401');
  assert.equal(contentCalls, 2);
});

test('createRedditClient enforces the 10MB size guard on the token endpoint response', async () => {
  const clock = makeClock();
  // Advertise a Content-Length well above the 10MB guard (SIZE = 20 MB).
  const oversized = String(20 * 1024 * 1024);
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).startsWith('https://www.reddit.com/api/v1/access_token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': oversized },
        },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createRedditClient({
    fetchImpl,
    clock,
    auth: { clientId: 'id', clientSecret: 'secret' },
  });

  await assert.rejects(
    () => client.getJson('/r/typescript/comments/abc123'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // Token response read is wrapped in an UNAVAILABLE error; the underlying
      // cause is the size-guard rejection from safeResponseText.
      const typed = err as { code?: string; cause?: unknown };
      assert.equal(typed.code, 'UNAVAILABLE');
      assert.match(err.message, /token response could not be read/i);
      assert.ok(typed.cause instanceof Error);
      assert.match((typed.cause as Error).message, /too large|size limit/i);
      return true;
    },
  );
});

test('OAuth token fetch is singleflighted across concurrent callers', async () => {
  const clock = makeClock();
  let tokenFetchCount = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      tokenFetchCount += 1;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({ access_token: 'tok-singleflight', token_type: 'bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ data: { children: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = createRedditClient({
    fetchImpl,
    clock,
    auth: { clientId: 'id', clientSecret: 'secret' },
  });

  await Promise.all([
    client.getJson('/r/typescript/comments/abc123'),
    client.getJson('/r/typescript/comments/def456'),
  ]);

  assert.equal(
    tokenFetchCount,
    1,
    'expected the OAuth token fetch to be singleflighted across concurrent callers',
  );
});

test('OAuth token fetch failure during singleflight propagates to all concurrent callers', async () => {
  const clock = makeClock();
  let tokenFetchCount = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      tokenFetchCount += 1;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ message: 'Unauthorized', error: 401 }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = createRedditClient({
    fetchImpl,
    clock,
    auth: { clientId: 'bad', clientSecret: 'creds' },
  });

  const results = await Promise.allSettled([
    client.getJson('/r/typescript/comments/abc123'),
    client.getJson('/r/typescript/comments/def456'),
  ]);

  assert.equal(
    tokenFetchCount,
    1,
    'expected the failing OAuth token fetch to be singleflighted across concurrent callers',
  );
  assert.equal(results[0]?.status, 'rejected');
  assert.equal(results[1]?.status, 'rejected');
});

test('resetRedditAuthCache clears cached OAuth tokens between tests', async () => {
  const clock = makeClock();
  let tokenIssued = 0;
  const { fetchImpl } = makeFetch((req) => {
    if (req.url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      tokenIssued += 1;
      return {
        status: 200,
        body: JSON.stringify({
          access_token: `tok-${String(tokenIssued)}`,
          token_type: 'bearer',
          expires_in: 3600,
        }),
      };
    }
    return { status: 200, body: JSON.stringify({ ok: true }) };
  });

  const clientA = createRedditClient({
    fetchImpl,
    clock,
    auth: { clientId: 'id', clientSecret: 'secret' },
  });
  await clientA.getJson('/r/typescript/comments/abc123');
  assert.equal(tokenIssued, 1);

  resetRedditAuthCache();

  const clientB = createRedditClient({
    fetchImpl,
    clock,
    auth: { clientId: 'id', clientSecret: 'secret' },
  });
  await clientB.getJson('/r/typescript/comments/def456');
  assert.equal(tokenIssued, 2);
});
