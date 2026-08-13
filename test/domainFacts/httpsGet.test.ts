import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { httpsGet, REQUEST_TIMEOUT_MS, MAX_BODY_BYTES } from '../../src/domainFacts/httpsGet.js';

// Local HTTPS fixtures. The private key is a throwaway test-only self-signed
// cert for localhost; tests connect with rejectUnauthorized:false.
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCNn5yVGS7sBAw4
rZwDhNrg8WsgmAwoF5UL9+fTFTMi4zrvRjv5FsvO//WpSnm5BlfRB3EHN1XJ5Qwk
YnEW0v4+3JkuJhJc29f8qVWr0Ch79iq1vXsQKU1kTNJ99sGkiZPcpwSLgsui2pD8
WPMHATe1CrLJ/1VUhIcaOpWjhmj8NAvznRLF9woyK1P52R3x6glswtrTFKG49KMc
iagak82lhgDQcbHGC3/oKSMSDiL6+qvkwaRt3BX3uS7bgdMzeBXCDWc5XYk66Dcx
BdaStsY1bZgxlQn9/+LY2TEGR8bZ/3+TE/TzA63r1KuLyDWmySobxECVcF1KDFjV
RBH1KvZrAgMBAAECggEAGA5QjpLkgXp+iPIUWhSrCSJ4y+SHzBeVXZ8SZaxoLzjh
vdr0PO8+Vz7q/4KDAoatS/gznsIrdEvPsC54fyP/w7W83zXgUJ2XJnes8a498jBy
OMSirrAVUUArUPIlGkm0L/q+ruPcqyDtF7AUN9BhIgNbMyyH1f9c43uoB0rBcnU0
EEWRKMnzJjZnYrcaEpH5ORkQylTIm5ht4SXAx4C7Re0iQynSVJrHt/lUQig8yToq
aDmvZpsM0Xw2d5OA2/c5NisJv+QmC3RJzBn6INj062S4Wnd+8JzPr1K97fEPJhV3
wva2PP4u78WUgeKSUJ6FtRYpZdHQoYD8VfxKpk7ZwQKBgQDBz11ZoxsUswotKrpe
cBavD86HvtesCULHCitrcC60No4U3q+uaLLwiHWzpT2VT29ek8HMRuvuBaXim5Ge
7JNBPUZCeowk9/7Nx7jZGMAnrKFfmOC60NJjTgTl1EyNlbmZPJHsUHdIxueLh+m+
Q7mlVh5gnuUE9jeHXxc5d0yQUwKBgQC7EVqkehVcPg8V25K5w/aWulxRh3YzN4kq
3k/XuhcHzYWT0F1YTgzwcubxUpZCBeZJHzt15zoI7wQe/zngNoStNUubV2F9qLAT
NeKaEMBOZ9QjRjIF88iU4VVSoWajtyaU62DMe3G4cIca4EqL6y6mFJNrmZBBh8RP
amLrYZgeiQKBgQCyhV7YZVxZib2S8yuuN5M9d9LmyQyCRBmFm8F4+mGa0DG52ZF7
lqdU1m2Mp2V9dikAthuqHZ3OptcxT9knyYSucFGahKU4nFLRm+mR17GQGfyfQQOo
MRfKLyBlz1Mgi8zk8Jz9TvVBTS4VIYFWJ64GNLhQiawtENr/T8DlxxT4TwKBgFEz
l0UOOXdw+NtkFKzOg5uqCajaRFS3JrOVDNN308dvTyx6pgpO1w8I0XavgsnmBbB3
/jePx4FZP1C1OUo6YB1PpSIpLAh/0O6F1XdLDi76ovss3Un4KHl31rGnngYy2myK
P9qDOzn0nrDr63ARBo7RH6z1W8kWRgCzDX1fP8kBAoGAYvfNuLpMbr10mI3+9uSq
wJc58O4e9AIqDZLYrscQjPWuvZP8AO5Iboz1pcMZJEBeGTEMS17yJLSyR5WTN9eZ
s8p6dFXkE+cODgw9B/Cv+I+aMVBrYKEjU3BFKDZ8gdtqdHVgvuAZTonyEjaE20f2
fvGh6M7SVk/oLAul4ggKznc=
-----END PRIVATE KEY-----`;

const CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUQw+6maEzUae+uTbfh7LhFmAshIUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgxMzAxNDExMloXDTM2MDgx
MDAxNDExMlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAjZ+clRku7AQMOK2cA4Ta4PFrIJgMKBeVC/fn0xUzIuM6
70Y7+RbLzv/1qUp5uQZX0QdxBzdVyeUMJGJxFtL+PtyZLiYSXNvX/KlVq9Aoe/Yq
tb17EClNZEzSffbBpImT3KcEi4LLotqQ/FjzBwE3tQqyyf9VVISHGjqVo4Zo/DQL
850SxfcKMitT+dkd8eoJbMLa0xShuPSjHImoGpPNpYYA0HGxxgt/6CkjEg4i+vqr
5MGkbdwV97ku24HTM3gVwg1nOV2JOug3MQXWkrbGNW2YMZUJ/f/i2NkxBkfG2f9/
kxP08wOt69Sri8g1pskqG8RAlXBdSgxY1UQR9Sr2awIDAQABo28wbTAdBgNVHQ4E
FgQUfoSJwPr2/CiCQFYhaUuJKyzGZtYwHwYDVR0jBBgwFoAUfoSJwPr2/CiCQFYh
aUuJKyzGZtYwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAG3rwKNs8Pm3Ic2Lw6ghSQsYdZLP+0LK
k+GDyhkM7k+IA6/eIXHrt2FZ/6lZS7tklRQL29nWGVnT2gQe00GX7oKD0/zbMUse
5lrMZBh6a/GAUVyFTvEl3Nz8ZDSs59YfXoLI/muzA+pWrWQRnOfmL8DH/1ZcejoA
/Tg8d7m+MI1OYIEUXrr9fI84MoO1TN39aArepqUwnAAlIDsmSm7E8KspTHyfYXeH
nDOzDoN8V54a/M4I/MfyhxhRiawJSkj1mbr6Mhe0rYXlh2z5333ScP5DRIwLFOSn
H2p1gUcnFWmiie1izdHR1n2XOG8uPhYsjZvw5IEbCfxIgSpWZfIqym8=
-----END CERTIFICATE-----`;

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{
  server: https.Server;
  url: (path: string) => string;
  close: () => Promise<void>;
}> {
  const server = https.createServer({ key: KEY, cert: CERT }, handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: (p: string) => `https://127.0.0.1:${port}${p}`,
        close: async () => {
          server.close();
          await once(server, 'close');
        },
      });
    });
  });
}

// 30s defaults (match module constants).
assert.equal(REQUEST_TIMEOUT_MS, 30_000);
assert.equal(MAX_BODY_BYTES, 50 * 1024 * 1024);

const INSECURE = { rejectUnauthorized: false };

test('httpsGet: fetches a 200 body', async () => {
  const s = await startServer((_req, res) => {
    res.statusCode = 200;
    res.end('hello https');
  });
  try {
    const r = await httpsGet(s.url('/ok'), { requestOptions: INSECURE });
    assert.equal(r.status, 200);
    assert.equal(r.data?.toString('utf8'), 'hello https');
  } finally {
    await s.close();
  }
});

test('httpsGet: surfaces redirects via location without a body', async () => {
  const s = await startServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', 'https://example.com/target');
    res.end();
  });
  try {
    const r = await httpsGet(s.url('/r'), { requestOptions: INSECURE });
    assert.equal(r.location, 'https://example.com/target');
    assert.equal(r.data, undefined);
  } finally {
    await s.close();
  }
});

test('httpsGet: resolves relative redirect Location against the request URL', async () => {
  const s = await startServer((_req, res) => {
    res.statusCode = 301;
    res.setHeader('location', '/redirected');
    res.end();
  });
  try {
    const r = await httpsGet(s.url('/start'), { requestOptions: INSECURE });
    assert.equal(r.location, s.url('/redirected'), 'relative Location resolved to absolute');
    assert.equal(r.data, undefined);
  } finally {
    await s.close();
  }
});

test('httpsGet: rejects redirect to private-network target', async () => {
  const s = await startServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', 'https://10.0.0.1/private');
    res.end();
  });
  try {
    await assert.rejects(httpsGet(s.url('/r'), { requestOptions: INSECURE }), /private-network/);
  } finally {
    await s.close();
  }
});

test('httpsGet: rejects redirect to non-HTTPS target', async () => {
  const s = await startServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', 'http://example.com/insecure');
    res.end();
  });
  try {
    await assert.rejects(httpsGet(s.url('/r'), { requestOptions: INSECURE }), /non-HTTPS redirect/);
  } finally {
    await s.close();
  }
});

test('httpsGet: rejects when the request stalls past the timeout', async () => {
  // Server accepts the connection but never sends a response byte.
  const s = await startServer((_req, _res) => {
    /* deliberately never respond */
  });
  try {
    await assert.rejects(
      httpsGet(s.url('/stall'), { timeoutMs: 150, requestOptions: INSECURE }),
      /timed out after 150ms/,
    );
  } finally {
    await s.close();
  }
});

test('httpsGet: rejects when the response is interrupted mid-body', async () => {
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial-');
    res.flushHeaders();
    // Destroy the socket before the body completes.
    setTimeout(() => res.socket?.destroy(), 50);
  });
  try {
    await assert.rejects(
      httpsGet(s.url('/interrupt'), { requestOptions: INSECURE }),
      /aborted|premature|interrupted/i,
    );
  } finally {
    await s.close();
  }
});

test('httpsGet: rejects when the response body exceeds the cap', async () => {
  const chunk = Buffer.alloc(1024, 0x61); // 1 KiB of 'a'
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    // Stream well past the cap so the client aborts mid-transfer.
    for (let n = 0; n < 64; n += 1) res.write(chunk);
    res.end();
  });
  try {
    await assert.rejects(
      httpsGet(s.url('/big'), { maxBodyBytes: 4096, requestOptions: INSECURE }),
      /exceeds 4096 bytes/,
    );
  } finally {
    await s.close();
  }
});

test('httpsGet: refuses non-HTTPS URLs', async () => {
  await assert.rejects(httpsGet('http://example.com/x'), /refusing non-HTTPS/);
});
