/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';

import {
  Attributes,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
} from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';

import {
  MatchPredicate,
  Policy,
  SourceKind,
  TraceMatcher,
  TraceSamplingConfig,
} from '../src/model';
import { PolicyStore } from '../src/store';
import { TraceSamplingPolicyImplementer } from '../src/trace-sampling';
import { logPolicy, tracePolicy } from './testutils';

function policy(
  policyId: string,
  options: {
    percentage: number;
    matchers?: TraceMatcher[];
    enabled?: boolean;
    keep?: Partial<TraceSamplingConfig>;
  }
): Policy {
  return tracePolicy(policyId, options);
}

function spanSampled(
  implementer: TraceSamplingPolicyImplementer,
  attributes: Attributes | undefined
): boolean {
  const tracerProvider = new TracerProvider({ sampler: implementer.sampler });
  const tracer = tracerProvider.getTracer('test');
  const span = tracer.startSpan('span', { attributes });
  span.end();
  return (span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0;
}

describe('TraceSamplingPolicyImplementer', () => {
  it('uses the fallback with no policies', () => {
    const implementer = new TraceSamplingPolicyImplementer();
    assert.strictEqual(
      spanSampled(implementer, { 'db.system': 'postgresql' }),
      true
    );
  });

  it('drops matched spans and falls back for unmatched', () => {
    const implementer = new TraceSamplingPolicyImplementer();
    const statuses = implementer.applyPolicies([
      policy('p1', { percentage: 0.0 }),
    ]);

    assert.deepStrictEqual(
      statuses.map(status => [status.applied, status.error]),
      [[true, '']]
    );
    assert.strictEqual(
      spanSampled(implementer, { 'db.system': 'postgresql' }),
      false
    );
    assert.strictEqual(spanSampled(implementer, { 'http.route': '/' }), true);
    assert.strictEqual(spanSampled(implementer, undefined), true);
  });

  it('samples matched spans at 100 percent', () => {
    const implementer = new TraceSamplingPolicyImplementer();
    implementer.applyPolicies([policy('p1', { percentage: 100.0 })]);

    assert.strictEqual(
      spanSampled(implementer, { 'db.system': 'postgresql' }),
      true
    );
  });

  it('most restrictive policy wins', () => {
    const implementer = new TraceSamplingPolicyImplementer();
    implementer.applyPolicies([
      policy('keep-all', { percentage: 100.0 }),
      policy('drop-all', { percentage: 0.0 }),
    ]);

    assert.strictEqual(
      spanSampled(implementer, { 'db.system': 'postgresql' }),
      false
    );
  });

  it('policy change applies to an existing tracer', () => {
    const implementer = new TraceSamplingPolicyImplementer();
    const tracerProvider = new TracerProvider({
      sampler: implementer.sampler,
    });
    const tracer = tracerProvider.getTracer('test');
    const attributes = { 'db.system': 'postgresql' };

    let span = tracer.startSpan('span', { attributes });
    span.end();
    assert.strictEqual(
      (span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0,
      true
    );

    implementer.applyPolicies([policy('p1', { percentage: 0.0 })]);
    span = tracer.startSpan('span', { attributes });
    span.end();
    assert.strictEqual(
      (span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0,
      false
    );

    implementer.applyPolicies([]);
    span = tracer.startSpan('span', { attributes });
    span.end();
    assert.strictEqual(
      (span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0,
      true
    );
  });

  it('child span follows parent decision', () => {
    const implementer = new TraceSamplingPolicyImplementer();
    implementer.applyPolicies([policy('p1', { percentage: 0.0 })]);
    const tracerProvider = new TracerProvider({
      sampler: implementer.sampler,
    });
    const tracer = tracerProvider.getTracer('test');

    const root = tracer.startSpan('root', {
      attributes: { 'db.system': 'postgresql' },
    });
    const child = tracer.startSpan(
      'child',
      { attributes: { 'http.route': '/' } },
      trace.setSpan(ROOT_CONTEXT, root)
    );
    child.end();
    root.end();

    assert.strictEqual(
      (root.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0,
      false
    );
    assert.strictEqual(
      (child.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0,
      false
    );
  });

  it('supports all matcher kinds', () => {
    const matcher = (
      match: MatchPredicate,
      options?: Partial<Pick<TraceMatcher, 'negate' | 'caseInsensitive'>>
    ): TraceMatcher[] => [
      {
        field: { kind: 'spanAttribute', path: ['http.route'] },
        match,
        negate: options?.negate ?? false,
        caseInsensitive: options?.caseInsensitive ?? false,
      },
    ];

    const cases: Array<[TraceMatcher[], Attributes, Attributes]> = [
      // [matchers, matching attributes, non-matching attributes]
      [
        matcher({ kind: 'exact', value: '/health' }),
        { 'http.route': '/health' },
        { 'http.route': '/Health' },
      ],
      [
        matcher({ kind: 'exact', value: '/health' }, { caseInsensitive: true }),
        { 'http.route': '/HEALTH' },
        { 'http.route': '/x' },
      ],
      [
        matcher({ kind: 'startsWith', value: '/health' }),
        { 'http.route': '/health/live' },
        { 'http.route': '/api/health' },
      ],
      [
        matcher({ kind: 'endsWith', value: 'live' }),
        { 'http.route': '/health/live' },
        { 'http.route': '/live/x' },
      ],
      [
        matcher({ kind: 'contains', value: 'health' }),
        { 'http.route': '/api/health/x' },
        { 'http.route': '/api' },
      ],
      [
        matcher({ kind: 'regex', pattern: '^/health(/.*)?$' }),
        { 'http.route': '/health/live' },
        { 'http.route': '/api/health' },
      ],
      [
        matcher({ kind: 'exists', value: false }),
        { other: 'x' },
        { 'http.route': '/x' },
      ],
      [
        matcher({ kind: 'exact', value: '/health' }, { negate: true }),
        { 'http.route': '/x' },
        { 'http.route': '/health' },
      ],
      // Non-string attribute values are matched by their string form.
      [
        [
          {
            field: { kind: 'spanAttribute', path: ['retry.count'] },
            match: { kind: 'exact', value: '3' },
            negate: false,
            caseInsensitive: false,
          },
        ],
        { 'retry.count': 3 },
        { 'retry.count': 4 },
      ],
    ];
    for (const [matchers, matching, nonMatching] of cases) {
      const implementer = new TraceSamplingPolicyImplementer();
      const statuses = implementer.applyPolicies([
        policy('p1', { percentage: 0.0, matchers }),
      ]);
      assert.strictEqual(statuses[0].applied, true);
      assert.strictEqual(
        spanSampled(implementer, matching),
        false,
        JSON.stringify(matchers)
      );
      assert.strictEqual(
        spanSampled(implementer, nonMatching),
        true,
        JSON.stringify(matchers)
      );
    }
  });

  it('supports the global trace_id matcher', () => {
    // The schema's idiom for a policy applying to all traces.
    const globalMatcher: TraceMatcher[] = [
      {
        field: { kind: 'traceField', name: 'trace_id' },
        match: { kind: 'exists', value: true },
        negate: false,
        caseInsensitive: false,
      },
    ];
    const implementer = new TraceSamplingPolicyImplementer();

    const statuses = implementer.applyPolicies([
      policy('global', { percentage: 0.0, matchers: globalMatcher }),
    ]);

    assert.strictEqual(statuses[0].applied, true);
    assert.strictEqual(
      spanSampled(implementer, { 'db.system': 'postgresql' }),
      false
    );
    assert.strictEqual(spanSampled(implementer, undefined), false);
  });

  it('ignored keep fields still apply the rate', () => {
    const implementer = new TraceSamplingPolicyImplementer();

    const statuses = implementer.applyPolicies([
      policy('p1', {
        percentage: 0.0,
        keep: { mode: 'equalizing', samplingPrecision: 6, failClosed: true },
      }),
    ]);

    assert.strictEqual(statuses[0].applied, true);
    assert.strictEqual(
      spanSampled(implementer, { 'db.system': 'postgresql' }),
      false
    );
  });

  it('unsupported policies fail open', () => {
    const unsupported = [
      policy('trace-field', {
        percentage: 5.0,
        matchers: [
          {
            field: { kind: 'traceField', name: 'span_name' },
            match: { kind: 'exists', value: true },
            negate: false,
            caseInsensitive: false,
          },
        ],
      }),
      policy('hash-seed', { percentage: 5.0, keep: { hashSeed: 7 } }),
      policy('nested-path', {
        percentage: 5.0,
        matchers: [
          {
            field: { kind: 'spanAttribute', path: ['a', 'b'] },
            match: { kind: 'exists', value: true },
            negate: false,
            caseInsensitive: false,
          },
        ],
      }),
      policy('resource-attribute', {
        percentage: 5.0,
        matchers: [
          {
            field: { kind: 'resourceAttribute', path: ['service.name'] },
            match: { kind: 'exists', value: true },
            negate: false,
            caseInsensitive: false,
          },
        ],
      }),
      policy('bad-regex', {
        percentage: 5.0,
        matchers: [
          {
            field: { kind: 'spanAttribute', path: ['http.route'] },
            match: { kind: 'regex', pattern: '[unclosed' },
            negate: false,
            caseInsensitive: false,
          },
        ],
      }),
    ];
    const implementer = new TraceSamplingPolicyImplementer();

    const statuses = implementer.applyPolicies([
      ...unsupported,
      policy('drop-all', { percentage: 0.0 }),
    ]);

    for (const status of statuses.slice(0, -1)) {
      assert.strictEqual(status.applied, false, JSON.stringify(status));
      assert.ok(status.error, JSON.stringify(status));
    }
    assert.strictEqual(statuses[statuses.length - 1].applied, true);
    assert.strictEqual(
      spanSampled(implementer, { 'db.system': 'postgresql' }),
      false
    );
  });

  it('disabled policy is not evaluated but applied', () => {
    const implementer = new TraceSamplingPolicyImplementer();

    const statuses = implementer.applyPolicies([
      policy('p1', { percentage: 0.0, enabled: false }),
    ]);

    assert.strictEqual(statuses[0].applied, true);
    assert.strictEqual(
      spanSampled(implementer, { 'db.system': 'postgresql' }),
      true
    );
  });

  it('policy without trace target reports an error', () => {
    const implementer = new TraceSamplingPolicyImplementer();

    const statuses = implementer.applyPolicies([logPolicy('p1')]);

    assert.strictEqual(statuses[0].applied, false);
    assert.ok(statuses[0].error.includes('no trace target'));
  });

  it('works through the policy store', () => {
    const implementer = new TraceSamplingPolicyImplementer();
    const store = new PolicyStore();
    store.addImplementer(implementer);

    const statuses = store.setPolicies(SourceKind.FILE, [
      policy('p1', { percentage: 0.0 }),
    ]);

    assert.strictEqual(statuses[0].applied, true);
    assert.strictEqual(
      spanSampled(implementer, { 'db.system': 'postgresql' }),
      false
    );
  });
});
