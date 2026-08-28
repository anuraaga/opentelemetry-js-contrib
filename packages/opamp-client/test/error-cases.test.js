/*
 * Copyright The OpenTelemetry Authors
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const assert = require('assert');
const http = require('http');

const { createOpAMPClient } = require('..');
const { MockOpAMPServer } = require('./mockopampserver');
const { barrierNDiagEvents, numIsApprox } = require('./testutils');

/**
 * Start an HTTP server with the given request handler, and return its
 * OpAMP-ish endpoint URL.
 */
async function startBadServer(handler) {
  const badOpampServer = http.createServer(handler);
  const addr = await new Promise(resolve => {
    badOpampServer.listen(0, '127.0.0.1', () => {
      resolve(badOpampServer.address());
    });
  });
  const endpoint = `http://${addr.address}:${addr.port}/v1/opamp`;
  return { badOpampServer, endpoint };
}

describe('OpAMPClient error cases', () => {
  it('error: ECONNREFUSED', async () => {
    const bogusEndpoint = 'http://127.0.0.1:6666/v1/opamp';

    const client = createOpAMPClient({
      endpoint: bogusEndpoint,
      diagEnabled: true,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();
    const events = await barrierNDiagEvents(3);

    // Expect a send failure and a scheduled next send in 30s (with jitter).
    assert.strictEqual(events[1].err.code, 'ECONNREFUSED');
    assert.strictEqual(events[2].errCount, 1);
    assert.ok(numIsApprox(events[2].delayMs, 30000, 0.1)); // allow 10% jitter on expected 30s

    await client.shutdown();
  });

  it('error: unexpected response status code', async () => {
    // Start a "bad" OpAMP server that responds 202, rather than 200.
    const { badOpampServer, endpoint } = await startBadServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(202); // Bad response status code.
        res.end();
      });
    });

    const client = createOpAMPClient({
      endpoint,
      diagEnabled: true,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();

    // Expect a send failure and a scheduled next send in 30s (with jitter).
    const events = await barrierNDiagEvents(3);
    assert.ok(events[1].err.includes('unexpected'));
    assert.strictEqual(events[2].errCount, 1);
    assert.ok(numIsApprox(events[2].delayMs, 30000, 0.1)); // allow 10% jitter on expected 30s

    badOpampServer.close();
    await client.shutdown();
  });

  it('HTTP 429 with Retry-After', async () => {
    const retryAfterS = 45;
    const { badOpampServer, endpoint } = await startBadServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(429, { 'retry-after': retryAfterS });
        res.end();
      });
    });

    const client = createOpAMPClient({
      endpoint,
      diagEnabled: true,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();

    // Expect the schedule event to be 45s (with jitter).
    const events = await barrierNDiagEvents(3);
    assert.strictEqual(events[1].retryAfterMs, retryAfterS * 1000);
    assert.ok(numIsApprox(events[2].delayMs, retryAfterS * 1000, 0.1));

    await client.shutdown();
    badOpampServer.close();
  });

  it('HTTP 503 with Retry-After', async () => {
    const retryAfterS = 42;
    const { badOpampServer, endpoint } = await startBadServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(503, { 'retry-after': retryAfterS });
        res.end();
      });
    });

    const client = createOpAMPClient({
      endpoint,
      diagEnabled: true,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();

    // Expect the schedule event to be `retryAfterS` (with jitter).
    const events = await barrierNDiagEvents(3);
    assert.strictEqual(events[1].retryAfterMs, retryAfterS * 1000);
    assert.ok(numIsApprox(events[2].delayMs, retryAfterS * 1000, 0.1));

    await client.shutdown();
    badOpampServer.close();
  });

  it('error: slow response body (bodyTimeout)', async () => {
    // Start a "bad" OpAMP server that is slow to respond with the body.
    const { badOpampServer, endpoint } = await startBadServer((req, res) => {
      req.resume();
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, {
            'content-type': 'application/x-protobuf',
          });
          res.flushHeaders();
        }, 200).unref();
        setTimeout(() => {
          res.end();
        }, 5000).unref(); // Longer than the 100ms bodyTimeout below.
      });
    });

    const client = createOpAMPClient({
      endpoint,
      diagEnabled: true,
      bodyTimeout: 100,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();

    // Expect a send failure and a scheduled next send in 30s (with jitter).
    const events = await barrierNDiagEvents(3);
    assert.strictEqual(events[1].err.code, 'UND_ERR_BODY_TIMEOUT');
    assert.ok(numIsApprox(events[2].delayMs, 30000, 0.1)); // allow 10% jitter on expected 30s

    await client.shutdown();
    badOpampServer.close();
  });

  it('error: ServerErrorResponse.type=UNKNOWN', async () => {
    const badServer = new MockOpAMPServer({
      badMode: 'server_error_response_unknown',
    });
    await badServer.start();

    const client = createOpAMPClient({
      endpoint: badServer.endpoint,
      diagEnabled: true,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();

    // Expect a send failure and a scheduled next send in 30s (with jitter).
    const events = await barrierNDiagEvents(3);
    assert.ok(events[1].err.includes('Unknown'));
    assert.ok(numIsApprox(events[2].delayMs, 30000, 0.1));

    await client.shutdown();
    await badServer.close();
  });

  it('error: ServerErrorResponse.type=UNAVAILABLE', async () => {
    const badServer = new MockOpAMPServer({
      badMode: 'server_error_response_unavailable',
    });
    await badServer.start();

    const client = createOpAMPClient({
      endpoint: badServer.endpoint,
      diagEnabled: true,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();

    // Expect a send failure and a scheduled next send in 30s (with jitter).
    const events = await barrierNDiagEvents(3);
    assert.ok(events[1].err.includes('Unavailable'));
    // 42s is the hardcoded value used by server_error_response_unavailable.
    assert.strictEqual(events[1].retryAfterMs, 42000);
    assert.ok(numIsApprox(events[2].delayMs, 42000, 0.1));

    await client.shutdown();
    await badServer.close();
  });
});
