/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Attributes, TraceFlags } from '@opentelemetry/api';
import {
  emptyResource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { Sampler, TracerProvider } from '@opentelemetry/sdk-trace';

import {
  OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE,
  OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL,
} from '../src/environment-variables';
import {
  _providersForTest,
  _resetForTest,
  getTelemetryPolicySampler,
  identifyingAttributes,
  nonIdentifyingAttributes,
  startTelemetryPolicyProviders,
} from '../src/entrypoints';

function sampled(sampler: Sampler, attributes: Attributes): boolean {
  const tracer = new TracerProvider({ sampler }).getTracer('test');
  const span = tracer.startSpan('span', { attributes });
  span.end();
  return (span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0;
}

function policyDocument(percentage: number): string {
  return JSON.stringify({
    policies: [
      {
        id: 'sample-database-spans',
        name: 'Sample database spans',
        trace: {
          match: [{ span_attribute: ['db.system'], exists: true }],
          keep: { percentage },
        },
      },
    ],
  });
}

describe('entrypoints', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE,
    OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL,
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    // Tear down the process-wide engine between tests.
    await _resetForTest();
  });

  it('returns a singleton sampler', () => {
    assert.strictEqual(
      getTelemetryPolicySampler(),
      getTelemetryPolicySampler()
    );
  });

  it('fallback ratio argument sets the fallback probability', () => {
    assert.strictEqual(
      sampled(getTelemetryPolicySampler('0'), { 'http.route': '/' }),
      false
    );
  });

  it('fallback ratio argument updates the existing sampler', () => {
    const sampler = getTelemetryPolicySampler();
    assert.strictEqual(sampled(sampler, { 'http.route': '/' }), true);

    assert.strictEqual(getTelemetryPolicySampler('0'), sampler);
    assert.strictEqual(sampled(sampler, { 'http.route': '/' }), false);
  });

  it('invalid fallback ratio uses the default fallback', () => {
    assert.strictEqual(
      sampled(getTelemetryPolicySampler('nope'), { 'http.route': '/' }),
      true
    );
  });

  it('start without config is a noop', () => {
    startTelemetryPolicyProviders(emptyResource());

    assert.strictEqual(_providersForTest().length, 0);
  });

  it('start with a policy file env starts a file provider', () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otel-telemetry-policy-')
    );
    const file = path.join(tmpDir, 'policies.json');
    fs.writeFileSync(file, policyDocument(0.0));
    process.env[OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE] = file;
    process.env[OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL] =
      '0';
    const sampler = getTelemetryPolicySampler();

    try {
      startTelemetryPolicyProviders(emptyResource());

      assert.strictEqual(
        sampled(sampler, { 'db.system': 'postgresql' }),
        false
      );
      assert.strictEqual(sampled(sampler, { 'http.route': '/' }), true);

      // A repeated call must not start duplicate providers.
      startTelemetryPolicyProviders(emptyResource());
      assert.strictEqual(_providersForTest().length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('splits resource attributes', () => {
    const resource = resourceFromAttributes({
      'service.name': 'svc',
      'service.instance.id': 'instance-1',
      'deployment.environment.name': 'prod',
    });

    const identifying = identifyingAttributes(resource);
    const nonIdentifying = nonIdentifyingAttributes(resource);

    assert.strictEqual(identifying['service.name'], 'svc');
    assert.strictEqual(identifying['service.instance.id'], 'instance-1');
    assert.ok(!('service.name' in nonIdentifying));
    assert.strictEqual(nonIdentifying['deployment.environment.name'], 'prod');
  });
});
