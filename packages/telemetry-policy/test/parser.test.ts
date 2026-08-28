/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';

import { parsePolicyDocument } from '../src/parser';

const SAMPLING_POLICY = {
  id: 'sample-database-spans-5-percent',
  name: 'Sample database spans at 5%',
  description: 'Aggressively samples database spans.',
  trace: {
    match: [{ span_attribute: ['db.system'], exists: true }],
    keep: { percentage: 5.0 },
  },
};

function document(...policies: unknown[]): string {
  return JSON.stringify({ policies });
}

describe('parsePolicyDocument', () => {
  it('parses a policy', () => {
    const result = parsePolicyDocument(document(SAMPLING_POLICY));

    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.policies.length, 1);
    const policy = result.policies[0];
    assert.strictEqual(policy.id, 'sample-database-spans-5-percent');
    assert.strictEqual(policy.name, 'Sample database spans at 5%');
    assert.strictEqual(
      policy.description,
      'Aggressively samples database spans.'
    );
    assert.strictEqual(policy.enabled, true);
    assert.strictEqual(policy.target.type, 'trace');
    if (policy.target.type !== 'trace') {
      throw new Error('unreachable');
    }
    assert.strictEqual(policy.target.keep.percentage, 5.0);
    assert.strictEqual(policy.target.match.length, 1);
    const matcher = policy.target.match[0];
    assert.deepStrictEqual(matcher.field, {
      kind: 'spanAttribute',
      path: ['db.system'],
    });
    assert.deepStrictEqual(matcher.match, { kind: 'exists', value: true });
    assert.strictEqual(matcher.negate, false);
    assert.strictEqual(matcher.caseInsensitive, false);
  });

  it('parses full sampling config and matcher options', () => {
    const raw = {
      id: 'p1',
      name: 'p1',
      enabled: false,
      created_at_unix_nano: 123,
      modified_at_unix_nano: 456,
      trace: {
        match: [
          {
            span_attribute: ['http.route'],
            regex: '^/health',
            negate: true,
            case_insensitive: true,
          },
        ],
        keep: {
          percentage: 25,
          mode: 'equalizing',
          sampling_precision: 6,
          hash_seed: 7,
          fail_closed: true,
        },
      },
    };

    const result = parsePolicyDocument(document(raw));

    assert.strictEqual(result.errors.length, 0);
    const policy = result.policies[0];
    assert.strictEqual(policy.enabled, false);
    assert.strictEqual(policy.createdAtUnixNano, 123n);
    assert.strictEqual(policy.modifiedAtUnixNano, 456n);
    if (policy.target.type !== 'trace') {
      throw new Error('expected trace target');
    }
    const keep = policy.target.keep;
    assert.strictEqual(keep.percentage, 25.0);
    assert.strictEqual(keep.mode, 'equalizing');
    assert.strictEqual(keep.samplingPrecision, 6);
    assert.strictEqual(keep.hashSeed, 7);
    assert.strictEqual(keep.failClosed, true);
    const matcher = policy.target.match[0];
    assert.deepStrictEqual(matcher.match, {
      kind: 'regex',
      pattern: '^/health',
    });
    assert.strictEqual(matcher.negate, true);
    assert.strictEqual(matcher.caseInsensitive, true);
  });

  it('skips an invalid policy and parses others', () => {
    const invalid = { id: 'missing-name', trace: SAMPLING_POLICY.trace };
    const result = parsePolicyDocument(document(invalid, SAMPLING_POLICY));

    assert.strictEqual(result.policies.length, 1);
    assert.strictEqual(
      result.policies[0].id,
      'sample-database-spans-5-percent'
    );
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].policyId, 'missing-name');
    assert.ok(result.errors[0].message.includes("'name'"));
  });

  const invalidCases: Array<[Record<string, unknown>, string]> = [
    [{ id: '' }, "'id'"],
    [{ enabled: 'yes' }, "'enabled'"],
    [{ trace: undefined, log: {}, metric: {} }, 'exactly one target'],
    [{ trace: { keep: { percentage: 5.0 } } }, "'trace.match'"],
    [{ trace: { match: [], keep: { percentage: 5.0 } } }, "'trace.match'"],
    [
      { trace: { match: [{ exists: true }], keep: { percentage: 5.0 } } },
      'exactly one field',
    ],
    [
      {
        trace: {
          match: [{ span_attribute: ['a'] }],
          keep: { percentage: 5.0 },
        },
      },
      'exactly one match',
    ],
    [
      {
        trace: {
          match: [{ span_attribute: ['a'], exists: true, exact: 'b' }],
          keep: { percentage: 5.0 },
        },
      },
      'exactly one match',
    ],
    [
      {
        trace: {
          match: [{ span_attribute: 'a', exists: true }],
          keep: { percentage: 5.0 },
        },
      },
      'array of strings',
    ],
    [
      { trace: { match: [{ span_attribute: ['a'], exists: true }] } },
      "'trace.keep'",
    ],
    [
      {
        trace: {
          match: [{ span_attribute: ['a'], exists: true }],
          keep: { percentage: 101 },
        },
      },
      '[0, 100]',
    ],
    [
      {
        trace: {
          match: [{ span_attribute: ['a'], exists: true }],
          keep: { percentage: true },
        },
      },
      'must be a number',
    ],
  ];
  for (const [mutation, expectedMessagePart] of invalidCases) {
    it(`reports error for invalid policy: ${expectedMessagePart}`, () => {
      const raw: Record<string, unknown> = {
        id: 'p1',
        name: 'p1',
        trace: SAMPLING_POLICY.trace,
        ...mutation,
      };
      for (const key of Object.keys(raw)) {
        if (raw[key] === undefined) {
          delete raw[key];
        }
      }

      const result = parsePolicyDocument(document(raw));

      assert.strictEqual(result.policies.length, 0);
      assert.strictEqual(result.errors.length, 1);
      assert.ok(
        result.errors[0].message.includes(expectedMessagePart),
        `expected '${expectedMessagePart}' in '${result.errors[0].message}'`
      );
    });
  }

  it('parses full message with protobuf JSON encodings', () => {
    const raw = {
      id: 'trace-sampling',
      name: 'Trace sampling rate',
      description: 'Set the global trace sampling rate to 10%.',
      enabled: true,
      created_at_unix_nano: '1718890000000000000',
      modified_at_unix_nano: '1718893600000000000',
      labels: [{ key: 'policy.scope', value: { string_value: 'global' } }],
      trace: {
        match: [
          {
            trace_field: 'trace_id',
            exists: true,
            negate: false,
            case_insensitive: false,
          },
        ],
        keep: {
          percentage: '10.0',
          mode: 'proportional',
          sampling_precision: 6,
          hash_seed: 0,
          fail_closed: false,
        },
      },
    };

    const result = parsePolicyDocument(document(raw));

    assert.strictEqual(result.errors.length, 0);
    const policy = result.policies[0];
    assert.strictEqual(policy.createdAtUnixNano, 1718890000000000000n);
    assert.strictEqual(policy.modifiedAtUnixNano, 1718893600000000000n);
    if (policy.target.type !== 'trace') {
      throw new Error('expected trace target');
    }
    assert.strictEqual(policy.target.keep.percentage, 10.0);
    const matcher = policy.target.match[0];
    assert.deepStrictEqual(matcher.field, {
      kind: 'traceField',
      name: 'trace_id',
    });
  });

  const invalidKeeps: unknown[] = [
    {},
    { probability: 0.1 },
    { percentage: 'nope' },
  ];
  for (const keep of invalidKeeps) {
    it(`rejects invalid keep values: ${JSON.stringify(keep)}`, () => {
      const raw = {
        id: 'p1',
        name: 'p1',
        trace: { match: [{ trace_field: 'trace_id', exists: true }], keep },
      };

      const result = parsePolicyDocument(document(raw));

      assert.strictEqual(result.policies.length, 0);
      assert.strictEqual(result.errors.length, 1);
    });
  }

  it('parses unimplemented targets without trace', () => {
    const raw = {
      id: 'drop-debug-logs',
      name: 'Drop debug and trace logs',
      log: {
        match: [{ log_field: 'severity_text', regex: '^(DEBUG|TRACE)$' }],
        keep: 'none',
      },
    };

    const result = parsePolicyDocument(document(raw));

    assert.strictEqual(result.errors.length, 0);
    const policy = result.policies[0];
    assert.deepStrictEqual(policy.target, { type: 'log' });
  });

  it('recognizes the profile target', () => {
    const raw = { id: 'p1', name: 'p1', profile: { anything: true } };

    const result = parsePolicyDocument(document(raw));

    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.policies[0].target.type, 'profile');
  });

  it('throws on invalid documents', () => {
    for (const raw of [
      'not json',
      '"a string"',
      JSON.stringify({ policies: 'nope' }),
      JSON.stringify(SAMPLING_POLICY),
      JSON.stringify([SAMPLING_POLICY]),
    ]) {
      assert.throws(() => parsePolicyDocument(raw));
    }
  });
});
