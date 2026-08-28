/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Path to a local policy document file.
 *
 * Setting it enables the file policy provider during
 * {@link startTelemetryPolicyProviders}.
 */
export const OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE =
  'OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE';

/**
 * Milliseconds between policy file change checks (default 30000; 0 reads
 * once).
 */
export const OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL =
  'OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL';

/**
 * OpAMP server URL.
 *
 * Setting it enables the OpAMP policy provider during
 * {@link startTelemetryPolicyProviders}.
 */
export const OTEL_NODE_EXPERIMENTAL_OPAMP_ENDPOINT =
  'OTEL_NODE_EXPERIMENTAL_OPAMP_ENDPOINT';

/**
 * Name of the OpAMP remote configuration entry to read the policy document
 * from.
 *
 * An OpAMP server sends remote configuration as one or more named entries.
 * Set this to the entry name your server delivers policies under, for example
 * `vendor`. Unset, the entry with the empty name is read, which servers
 * commonly use when they send a single configuration.
 */
export const OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_OPAMP_KEY =
  'OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_OPAMP_KEY';
