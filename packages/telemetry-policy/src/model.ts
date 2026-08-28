/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

// TypeScript structure corresponding to proposed protobuf schema in OTEP 4738.
// Much of the structure is oneofs, which we model with discriminated unions.

/** The policy schema's "target" oneof field names. */
export type TargetType = 'log' | 'metric' | 'profile' | 'trace';

export const KNOWN_TARGET_TYPES: readonly TargetType[] = [
  'log',
  'metric',
  'profile',
  'trace',
];

/**
 * Where a policy came from.
 *
 * A lower enum value indicates a higher priority policy and will take
 * precedence if multiple are run.
 */
export enum SourceKind {
  OPAMP = 1,
  HTTP = 2,
  FILE = 3,
  CUSTOM = 4,
}

// The TraceMatcher's "field" oneof, one variant per member.

export type TraceMatcherField =
  /** A simple trace/span field by name, e.g. `trace_id`. */
  | { kind: 'traceField'; name: string }
  | { kind: 'spanAttribute'; path: string[] }
  | { kind: 'resourceAttribute'; path: string[] }
  | { kind: 'scopeAttribute'; path: string[] }
  | { kind: 'eventAttribute'; path: string[] }
  | { kind: 'spanKind'; value: string }
  | { kind: 'spanStatus'; value: string }
  | { kind: 'eventName'; value: string }
  | { kind: 'linkTraceId'; value: string };

// The matcher's "match" predicate oneof.

export type MatchPredicate =
  | { kind: 'exact'; value: string }
  | { kind: 'regex'; pattern: string }
  | { kind: 'exists'; value: boolean }
  | { kind: 'startsWith'; value: string }
  | { kind: 'endsWith'; value: string }
  | { kind: 'contains'; value: string };

/** One matcher from a trace target's ANDed matcher list. */
export interface TraceMatcher {
  field: TraceMatcherField;
  match: MatchPredicate;
  negate: boolean;
  caseInsensitive: boolean;
}

/** The trace target's keep configuration. */
export interface TraceSamplingConfig {
  percentage: number;
  mode: string;
  samplingPrecision: number;
  hashSeed: number;
  failClosed: boolean;
}

export type PolicyTarget =
  /** Recognized targets with no implementer yet; their content is not modeled. */
  | { type: 'log' }
  | { type: 'metric' }
  | { type: 'profile' }
  | { type: 'trace'; match: TraceMatcher[]; keep: TraceSamplingConfig };

/** A parsed telemetry policy. */
export interface Policy {
  id: string;
  name: string;
  target: PolicyTarget;
  description: string;
  enabled: boolean;
  createdAtUnixNano: bigint;
  modifiedAtUnixNano: bigint;
}

/** Outcome of applying one policy, keyed by policy id. */
export interface PolicyApplyStatus {
  policyId: string;
  applied: boolean;
  error: string;
}
