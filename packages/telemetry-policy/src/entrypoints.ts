/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment-driven setup, the equivalent of auto-instrumentation
 * entry points in other OpenTelemetry languages.
 */

import { diag } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { Sampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace';

import {
  OTEL_NODE_EXPERIMENTAL_OPAMP_ENDPOINT,
  OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE,
  OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL,
  OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_OPAMP_KEY,
} from './environment-variables';
import { OpAMPPolicyProvider } from './opamp';
import { FilePolicyProvider, PolicyProvider } from './provider';
import { PolicyStore } from './store';
import { TraceSamplingPolicyImplementer } from './trace-sampling';

const IDENTIFYING_ATTRIBUTE_KEYS = [
  'service.name',
  'service.namespace',
  'service.instance.id',
];

// Keep track of providers to be able to shut down and reinitialize in tests.
let providers: PolicyProvider[] = [];
let providersStarted = false;

let store = new PolicyStore();

// We don't assume ordering between the sampler getter and provider startup.
// Unless actually started, the trace implementer is very lightweight to
// initialize, so we go ahead and just eagerly initialize it here to avoid
// ordering constraints.
let traceImplementer = new TraceSamplingPolicyImplementer();
store.addImplementer(traceImplementer);

/**
 * Return the singleton telemetry policy sampler, to pass as the SDK's
 * sampler.
 *
 * @param fallbackRatio optionally sets the fallback sampling probability
 *     (0-1) for spans no policy matches, replacing the default always-on
 *     fallback.
 */
export function getTelemetryPolicySampler(
  fallbackRatio?: string | number
): Sampler {
  if (fallbackRatio !== undefined && fallbackRatio !== '') {
    const ratio = Number(fallbackRatio);
    if (isNaN(ratio)) {
      diag.warn(
        `invalid fallback ratio '${fallbackRatio}' for telemetry policy sampler, using default fallback`
      );
    } else {
      traceImplementer.setFallback(new TraceIdRatioBasedSampler(ratio));
    }
  }
  return traceImplementer.sampler;
}

/**
 * Start policy providers configured through environment variables, if any.
 *
 * @param resource the SDK resource, used to identify the agent to an OpAMP
 *     server.
 */
export function startTelemetryPolicyProviders(resource: Resource): void {
  const policyFile = process.env[OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE];
  const opampEndpoint = process.env[OTEL_NODE_EXPERIMENTAL_OPAMP_ENDPOINT];
  if (!policyFile && !opampEndpoint) {
    return;
  }

  if (providersStarted) {
    diag.warn(
      'Telemetry policy providers already started. The OpenTelemetry SDK ' +
        'was initialized more than once in this process'
    );
    return;
  }
  providersStarted = true;

  if (policyFile) {
    const fileProvider = new FilePolicyProvider({
      path: policyFile,
      store,
      pollIntervalMillis: filePollIntervalMillis(),
    });
    fileProvider.start();
    providers.push(fileProvider);
  }

  if (opampEndpoint) {
    const opampProvider = new OpAMPPolicyProvider({
      endpoint: opampEndpoint,
      store,
      identifyingAttributes: identifyingAttributes(resource),
      nonIdentifyingAttributes: nonIdentifyingAttributes(resource),
      configMapKey:
        process.env[OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_OPAMP_KEY] ?? '',
    });
    opampProvider.start();
    providers.push(opampProvider);
  }
}

/** Shut down any policy providers started by {@link startTelemetryPolicyProviders}. */
export async function shutdownTelemetryPolicyProviders(): Promise<void> {
  const toShutdown = providers;
  providers = [];
  providersStarted = false;
  await Promise.all(toShutdown.map(provider => provider.shutdown()));
}

/** Reset the process-wide state. Only for use in tests. */
export async function _resetForTest(): Promise<void> {
  await shutdownTelemetryPolicyProviders();
  store = new PolicyStore();
  traceImplementer = new TraceSamplingPolicyImplementer();
  store.addImplementer(traceImplementer);
}

/** The providers started from environment configuration. Only for use in tests. */
export function _providersForTest(): PolicyProvider[] {
  return providers;
}

function filePollIntervalMillis(): number {
  const raw =
    process.env[OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL];
  if (raw === undefined || raw === '') {
    return 30000;
  }
  const parsed = Number(raw);
  if (isNaN(parsed)) {
    diag.warn(
      `invalid ${OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL} '${raw}', using 30000`
    );
    return 30000;
  }
  return parsed;
}

export function identifyingAttributes(
  resource: Resource
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const key of IDENTIFYING_ATTRIBUTE_KEYS) {
    if (resource.attributes[key] !== undefined) {
      attributes[key] = resource.attributes[key];
    }
  }
  return attributes;
}

export function nonIdentifyingAttributes(
  resource: Resource
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resource.attributes)) {
    if (
      !IDENTIFYING_ATTRIBUTE_KEYS.includes(key) &&
      (typeof value === 'string' ||
        typeof value === 'boolean' ||
        typeof value === 'number')
    ) {
      attributes[key] = value;
    }
  }
  return attributes;
}
