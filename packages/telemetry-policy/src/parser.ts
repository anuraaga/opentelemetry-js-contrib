/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  KNOWN_TARGET_TYPES,
  MatchPredicate,
  Policy,
  PolicyTarget,
  TargetType,
  TraceMatcher,
  TraceMatcherField,
  TraceSamplingConfig,
} from './model';

// Parses a policy document. All of the logic in this file should be replaced
// by parsing using a protobuf schema in the future.

type JsonObject = { [key: string]: unknown };

const ATTRIBUTE_PATH_FIELD_KINDS = {
  span_attribute: 'spanAttribute',
  resource_attribute: 'resourceAttribute',
  scope_attribute: 'scopeAttribute',
  event_attribute: 'eventAttribute',
} as const;
const STRING_FIELD_KINDS = {
  trace_field: 'traceField',
  span_kind: 'spanKind',
  span_status: 'spanStatus',
  event_name: 'eventName',
  link_trace_id: 'linkTraceId',
} as const;
const FIELD_KEYS = [
  ...Object.keys(STRING_FIELD_KINDS),
  ...Object.keys(ATTRIBUTE_PATH_FIELD_KINDS),
];

const STRING_MATCH_KINDS = {
  exact: 'exact',
  regex: 'regex',
  starts_with: 'startsWith',
  ends_with: 'endsWith',
  contains: 'contains',
} as const;
const MATCH_KEYS = [...Object.keys(STRING_MATCH_KINDS), 'exists'];

/** A policy that could not be parsed. */
export interface PolicyParseError {
  policyId: string;
  message: string;
}

export interface PolicyParseResult {
  policies: Policy[];
  errors: PolicyParseError[];
}

class PolicyError extends Error {}

/**
 * Parse a JSON policy document into policies.
 *
 * The document is a JSON object with a `policies` array of policy objects.
 * Field names follow the telemetry policy schema's snake_case JSON form. An
 * invalid policy is skipped and reported in `errors`.
 *
 * @throws Error if the document itself is not valid JSON or not one of the
 *     accepted document shapes. Callers should keep their previous policy
 *     snapshot in that case.
 */
export function parsePolicyDocument(text: string): PolicyParseResult {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (err) {
    throw new Error(`policy document is not valid JSON: ${err}`);
  }

  let rawPolicies: unknown;
  if (isJsonObject(document)) {
    rawPolicies = document['policies'];
  }
  if (!Array.isArray(rawPolicies)) {
    throw new Error(
      "policy document must be a JSON object with a 'policies' array"
    );
  }

  const policies: Policy[] = [];
  const errors: PolicyParseError[] = [];
  for (const rawPolicy of rawPolicies) {
    if (!isJsonObject(rawPolicy)) {
      errors.push({ policyId: '', message: 'policy is not a JSON object' });
      continue;
    }
    const rawId = rawPolicy['id'];
    const policyId = typeof rawId === 'string' ? rawId : '';
    try {
      policies.push(parsePolicy(rawPolicy));
    } catch (err) {
      if (err instanceof PolicyError) {
        errors.push({ policyId, message: err.message });
      } else {
        throw err;
      }
    }
  }
  return { policies, errors };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePolicy(raw: JsonObject): Policy {
  const policyId = requiredString(raw, 'id');
  const name = requiredString(raw, 'name');
  const description = optionalString(raw, 'description');
  const enabled = raw['enabled'] ?? true;
  if (typeof enabled !== 'boolean') {
    throw new PolicyError("'enabled' must be a boolean");
  }

  const targets: TargetType[] = KNOWN_TARGET_TYPES.filter(key => key in raw);
  if (targets.length !== 1) {
    throw new PolicyError(
      `exactly one target of [${KNOWN_TARGET_TYPES.join(
        ', '
      )}] must be set, got [${targets.join(', ')}]`
    );
  }
  const targetType = targets[0];

  let target: PolicyTarget;
  if (targetType === 'trace') {
    target = parseTraceTarget(raw['trace']);
  } else {
    target = { type: targetType };
  }

  return {
    id: policyId,
    name,
    target,
    description,
    enabled,
    createdAtUnixNano: optionalBigInt(raw, 'created_at_unix_nano'),
    modifiedAtUnixNano: optionalBigInt(raw, 'modified_at_unix_nano'),
  };
}

function parseTraceTarget(raw: unknown): PolicyTarget {
  const target = requiredObject(raw, 'trace');
  const rawMatch = target['match'];
  if (!Array.isArray(rawMatch) || rawMatch.length === 0) {
    throw new PolicyError(
      "'trace.match' must be a non-empty array of matchers"
    );
  }
  const matchers = rawMatch.map(rawMatcher => parseTraceMatcher(rawMatcher));
  const keep = parseTraceSamplingConfig(target['keep']);
  return { type: 'trace', match: matchers, keep };
}

function parseTraceMatcher(raw: unknown): TraceMatcher {
  const matcher = requiredObject(raw, 'matcher');

  const fieldKeys = FIELD_KEYS.filter(key => key in matcher);
  if (fieldKeys.length !== 1) {
    throw new PolicyError(
      `matcher must set exactly one field, got [${fieldKeys.join(', ')}]`
    );
  }
  const fieldKey = fieldKeys[0];
  const rawFieldValue = matcher[fieldKey];
  let field: TraceMatcherField;
  if (fieldKey in ATTRIBUTE_PATH_FIELD_KINDS) {
    field = {
      kind: ATTRIBUTE_PATH_FIELD_KINDS[
        fieldKey as keyof typeof ATTRIBUTE_PATH_FIELD_KINDS
      ],
      path: attributePath(fieldKey, rawFieldValue),
    };
  } else if (typeof rawFieldValue === 'string') {
    const kind =
      STRING_FIELD_KINDS[fieldKey as keyof typeof STRING_FIELD_KINDS];
    if (kind === 'traceField') {
      field = { kind, name: rawFieldValue };
    } else {
      field = { kind, value: rawFieldValue };
    }
  } else {
    throw new PolicyError(`matcher field '${fieldKey}' must be a string`);
  }

  const matchKeys = MATCH_KEYS.filter(key => key in matcher);
  if (matchKeys.length !== 1) {
    throw new PolicyError(
      `matcher must set exactly one match of [${MATCH_KEYS.join(
        ', '
      )}], got [${matchKeys.join(', ')}]`
    );
  }
  const matchKey = matchKeys[0];
  const matchValue = matcher[matchKey];
  let match: MatchPredicate;
  if (matchKey === 'exists') {
    if (typeof matchValue !== 'boolean') {
      throw new PolicyError("matcher 'exists' must be a boolean");
    }
    match = { kind: 'exists', value: matchValue };
  } else if (typeof matchValue === 'string') {
    const kind =
      STRING_MATCH_KINDS[matchKey as keyof typeof STRING_MATCH_KINDS];
    if (kind === 'regex') {
      match = { kind, pattern: matchValue };
    } else {
      match = { kind, value: matchValue };
    }
  } else {
    throw new PolicyError(`matcher '${matchKey}' must be a string`);
  }

  return {
    field,
    match,
    negate: optionalBool(matcher, 'negate'),
    caseInsensitive: optionalBool(matcher, 'case_insensitive'),
  };
}

function attributePath(fieldName: string, rawValue: unknown): string[] {
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    throw new PolicyError(
      `matcher field '${fieldName}' must be a non-empty array of strings`
    );
  }
  const segments: string[] = [];
  for (const segment of rawValue) {
    if (typeof segment !== 'string') {
      throw new PolicyError(
        `matcher field '${fieldName}' must be a non-empty array of strings`
      );
    }
    segments.push(segment);
  }
  return segments;
}

function parseTraceSamplingConfig(raw: unknown): TraceSamplingConfig {
  const keep = requiredObject(raw, 'trace.keep');
  const percentage = number(keep, 'percentage');
  if (!(percentage >= 0.0 && percentage <= 100.0)) {
    throw new PolicyError(
      `'trace.keep.percentage' must be in [0, 100], got ${percentage}`
    );
  }
  return {
    percentage,
    mode: optionalString(keep, 'mode'),
    samplingPrecision: optionalInt(keep, 'sampling_precision'),
    hashSeed: optionalInt(keep, 'hash_seed'),
    failClosed: optionalBool(keep, 'fail_closed'),
  };
}

function requiredObject(raw: unknown, name: string): JsonObject {
  if (!isJsonObject(raw)) {
    throw new PolicyError(`'${name}' must be a JSON object`);
  }
  return raw;
}

function requiredString(raw: JsonObject, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value) {
    throw new PolicyError(`'${key}' must be a non-empty string`);
  }
  return value;
}

function optionalString(raw: JsonObject, key: string): string {
  const value = raw[key] ?? '';
  if (typeof value !== 'string') {
    throw new PolicyError(`'${key}' must be a string`);
  }
  return value;
}

function number(raw: JsonObject, key: string): number {
  // Protobuf JSON allows numbers to be encoded as strings.
  const value = raw[key];
  if (typeof value === 'string') {
    const parsed = value.trim() === '' ? NaN : Number(value);
    if (isNaN(parsed)) {
      throw new PolicyError(`'${key}' must be a number`);
    }
    return parsed;
  }
  if (typeof value !== 'number') {
    throw new PolicyError(`'${key}' must be a number`);
  }
  return value;
}

function optionalInt(raw: JsonObject, key: string): number {
  // Protobuf JSON encodes 64-bit integers as strings.
  const value = raw[key] ?? 0;
  if (typeof value === 'string') {
    const parsed = parseIntStrict(value);
    if (parsed === undefined) {
      throw new PolicyError(`'${key}' must be an integer`);
    }
    return parsed;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PolicyError(`'${key}' must be an integer`);
  }
  return value;
}

function optionalBigInt(raw: JsonObject, key: string): bigint {
  // Protobuf JSON encodes 64-bit integers as strings.
  const value = raw[key] ?? 0;
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      throw new PolicyError(`'${key}' must be an integer`);
    }
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PolicyError(`'${key}' must be an integer`);
  }
  return BigInt(value);
}

function optionalBool(raw: JsonObject, key: string): boolean {
  const value = raw[key] ?? false;
  if (typeof value !== 'boolean') {
    throw new PolicyError(`'${key}' must be a boolean`);
  }
  return value;
}

function parseIntStrict(value: string): number | undefined {
  if (!/^[+-]?\d+$/.test(value.trim())) {
    return undefined;
  }
  return Number(value);
}
