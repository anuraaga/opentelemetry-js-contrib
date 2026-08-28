/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  KNOWN_TARGET_TYPES,
  SourceKind,
  type MatchPredicate,
  type Policy,
  type PolicyApplyStatus,
  type PolicyTarget,
  type TargetType,
  type TraceMatcher,
  type TraceMatcherField,
  type TraceSamplingConfig,
} from './model';
export {
  parsePolicyDocument,
  type PolicyParseError,
  type PolicyParseResult,
} from './parser';
export { type PolicyImplementer } from './implementer';
export { PolicyStore } from './store';
export {
  FilePolicyProvider,
  type FilePolicyProviderOptions,
  type PolicyProvider,
} from './provider';
export { TraceSamplingPolicyImplementer } from './trace-sampling';
export {
  OpAMPPolicyCallbacks,
  OpAMPPolicyProvider,
  type OpAMPPolicyClient,
  type OpAMPPolicyProviderClient,
  type OpAMPPolicyProviderOptions,
} from './opamp';
export {
  getTelemetryPolicySampler,
  shutdownTelemetryPolicyProviders,
  startTelemetryPolicyProviders,
} from './entrypoints';
export {
  OTEL_NODE_EXPERIMENTAL_OPAMP_ENDPOINT,
  OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE,
  OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL,
  OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_OPAMP_KEY,
} from './environment-variables';
