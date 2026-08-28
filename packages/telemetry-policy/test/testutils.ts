/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Policy, TraceMatcher, TraceSamplingConfig } from '../src/model';
import { PolicyStore } from '../src/store';

export const DEFAULT_MATCHERS: TraceMatcher[] = [
  {
    field: { kind: 'spanAttribute', path: ['db.system'] },
    match: { kind: 'exists', value: true },
    negate: false,
    caseInsensitive: false,
  },
];

export function tracePolicy(
  policyId: string,
  options?: {
    percentage?: number;
    enabled?: boolean;
    matchers?: TraceMatcher[];
    keep?: Partial<TraceSamplingConfig>;
  }
): Policy {
  return {
    id: policyId,
    name: policyId,
    description: '',
    enabled: options?.enabled ?? true,
    createdAtUnixNano: 0n,
    modifiedAtUnixNano: 0n,
    target: {
      type: 'trace',
      match: options?.matchers ?? DEFAULT_MATCHERS,
      keep: {
        percentage: options?.percentage ?? 5.0,
        mode: '',
        samplingPrecision: 0,
        hashSeed: 0,
        failClosed: false,
        ...options?.keep,
      },
    },
  };
}

export function logPolicy(policyId: string, enabled = true): Policy {
  return {
    id: policyId,
    name: policyId,
    description: '',
    enabled,
    createdAtUnixNano: 0n,
    modifiedAtUnixNano: 0n,
    target: { type: 'log' },
  };
}

/** Percentages of the store's current effective trace policies. */
export function currentPercentages(store: PolicyStore): number[] {
  const effective = (
    store as unknown as { _effectivePolicies(): Policy[] }
  )._effectivePolicies();
  return effective
    .map(policy => policy.target)
    .filter(target => target.type === 'trace')
    .map(target => (target.type === 'trace' ? target.keep.percentage : 0));
}
