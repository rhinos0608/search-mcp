import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeUrl, safeFetch } from '../src/httpGuards.js';

test('address classifier blocks legacy IPv4 encodings', () => {
  for (const host of ['2130706433', '0x7f000001', '0177.0.0.1', '224.0.0.1', '0.0.0.0']) {
    assert.throws(() => assertSafeUrl(`http://${host}/`), /Blocked/);
  }
});

test('address classifier blocks prohibited IPv6 ranges', () => {
  for (const host of [
    '[::1]',
    '[fe80::1]',
    '[fe90::1]',
    '[febf::1]',
    '[fc00::1]',
    '[fc7f:ffff::1]',
    '[fc80::1]',
    '[fd00::1]',
    '[fd12:3456::1]',
    '[fdff:ffff::1]',
  ]) {
    assert.throws(() => assertSafeUrl(`http://${host}/`), /Blocked/);
  }
  assert.doesNotThrow(() => assertSafeUrl('http://[2001:4860:4860::8888]/'));
});

test('safeFetch matches direct IPv6 ULA classification', async () => {
  for (const address of [
    'fc00::1',
    'fc7f:ffff::1',
    'fc80::1',
    'fd00::1',
    'fd12:3456::1',
    'fdff:ffff::1',
  ]) {
    let requests = 0;
    await assert.rejects(
      () =>
        safeFetch(
          'http://internal.example/',
          {},
          {
            resolver: async () => [{ address, family: 6 }],
            request: async () => {
              requests += 1;
              return { statusCode: 200, headers: {}, body: new Uint8Array() };
            },
          },
        ),
      /private DNS/,
    );
    assert.equal(requests, 0);
  }
});

test('pre-abort performs zero DNS and transport work', async () => {
  const signal = AbortSignal.abort();
  let lookups = 0;
  let requests = 0;
  await assert.rejects(
    () =>
      safeFetch(
        'https://example.com/',
        {},
        {
          signal,
          resolver: async () => {
            lookups += 1;
            return [{ address: '93.184.216.34', family: 4 }];
          },
          request: async () => {
            requests += 1;
            return { statusCode: 200, headers: {}, body: new Uint8Array() };
          },
        },
      ),
    /aborted/,
  );
  assert.equal(lookups, 0);
  assert.equal(requests, 0);
});

test('resolver answers must match address family', async () => {
  await assert.rejects(
    () =>
      safeFetch(
        'https://example.com/',
        {},
        {
          resolver: async () => [{ address: '93.184.216.34', family: 6 }],
          request: async () => {
            throw new Error('must not request');
          },
        },
      ),
    /invalid address or family/,
  );
});

test('operator internal requires exact configured host and rejects prohibited addresses', async () => {
  await assert.rejects(
    () =>
      safeFetch(
        'http://internal.example/',
        {},
        {
          networkPolicy: 'operator_internal',
          internalAllowlist: ['other.example'],
          resolver: async () => [{ address: '127.0.0.1', family: 4 }],
        },
      ),
    /configured endpoint authorization/,
  );
  await assert.rejects(
    () =>
      safeFetch(
        'http://internal.example/',
        {},
        {
          networkPolicy: 'operator_internal',
          internalAllowlist: ['internal.example'],
          resolver: async () => [{ address: '0.0.0.0', family: 4 }],
          request: async () => {
            throw new Error('must not request');
          },
        },
      ),
    /private or reserved/,
  );
});

test('timed out injected transport is cancelled and listeners are removed', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let adds = 0;
  let removes = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof signal.addEventListener>) => {
    adds += 1;
    return add(...args);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<typeof signal.removeEventListener>) => {
    removes += 1;
    return remove(...args);
  }) as typeof signal.removeEventListener;
  await assert.rejects(
    () =>
      safeFetch(
        'https://example.com/',
        {},
        {
          signal,
          timeoutMs: 10,
          resolver: async () => [{ address: '93.184.216.34', family: 4 }],
          request: async (_options, _maxBytes, requestSignal) =>
            new Promise((_resolve) => {
              requestSignal?.addEventListener('abort', () => {
                cancelled = true;
              });
            }),
        },
      ),
    /deadline exceeded/,
  );
  assert.equal(cancelled, true);
  assert.equal(adds, removes);
});

test('injected request errors clean up abort listeners', async () => {
  const controller = new AbortController();
  let adds = 0;
  let removes = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof signal.addEventListener>) => {
    adds += 1;
    return add(...args);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<typeof signal.removeEventListener>) => {
    removes += 1;
    return remove(...args);
  }) as typeof signal.removeEventListener;
  await assert.rejects(
    () =>
      safeFetch(
        'https://example.com/',
        {},
        {
          signal,
          resolver: async () => [{ address: '93.184.216.34', family: 4 }],
          request: async () => {
            throw new Error('transport failed');
          },
        },
      ),
    /transport failed/,
  );
  assert.equal(adds, removes);
});

test('operator_internal rejects full fe80::/10 link-local range', async () => {
  for (const address of ['fe80::1', 'fe90::1', 'febf::1']) {
    await assert.rejects(
      () =>
        safeFetch(
          'http://internal.example/',
          {},
          {
            networkPolicy: 'operator_internal',
            internalAllowlist: ['internal.example'],
            resolver: async () => [{ address, family: 6 }],
            request: async () => {
              throw new Error('must not request');
            },
          },
        ),
      /private or reserved/,
    );
  }
});

test('body cap applies to injected transport', async () => {
  await assert.rejects(
    () =>
      safeFetch(
        'https://example.com/',
        {},
        {
          maxBytes: 2,
          resolver: async () => [{ address: '93.184.216.34', family: 4 }],
          request: async () => ({ statusCode: 200, headers: {}, body: new Uint8Array([1, 2, 3]) }),
        },
      ),
    /exceeded size limit/,
  );
});
