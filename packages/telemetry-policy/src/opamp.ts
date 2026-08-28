/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { diag } from '@opentelemetry/api';
import {
  AgentCapabilities,
  AgentRemoteConfig,
  EffectiveConfigInput,
  OnMessageData,
  RemoteConfigStatuses,
  RemoteConfigStatusInput,
  createOpAMPClient,
} from '@opentelemetry/opamp-client';

import { SourceKind } from './model';
import { parsePolicyDocument } from './parser';
import { PolicyProvider } from './provider';
import { PolicyStore } from './store';

/**
 * The subset of the OpAMP client interface used to apply policies, to allow
 * substituting the client in tests.
 */
export interface OpAMPPolicyClient {
  setRemoteConfigStatus(remoteConfigStatus: RemoteConfigStatusInput): void;
  setEffectiveConfig(effectiveConfig: EffectiveConfigInput): void;
}

/**
 * The client interface required by {@link OpAMPPolicyProvider}, matching
 * `@opentelemetry/opamp-client`'s `OpAMPClient`.
 */
export interface OpAMPPolicyProviderClient extends OpAMPPolicyClient {
  setAgentDescription(desc: {
    identifyingAttributes?: object;
    nonIdentifyingAttributes?: object;
  }): void;
  start(): void;
  shutdown(): Promise<void>;
}

/** OpAMP message handling that applies remote config policy documents. */
export class OpAMPPolicyCallbacks {
  private _store: PolicyStore;
  private _configMapKey: string;

  constructor(options: { store: PolicyStore; configMapKey?: string }) {
    this._store = options.store;
    this._configMapKey = options.configMapKey ?? '';
  }

  public onMessage(client: OpAMPPolicyClient, message: OnMessageData): void {
    const remoteConfig = message.remoteConfig;
    if (remoteConfig === undefined) {
      return;
    }
    let status: number;
    let errorMessage: string;
    try {
      [status, errorMessage] = this._applyRemoteConfig(client, remoteConfig);
    } catch (err) {
      diag.error('failed to process remote config policies', err);
      status = RemoteConfigStatuses.RemoteConfigStatuses_FAILED;
      errorMessage = 'internal error processing policies';
    }
    client.setRemoteConfigStatus({
      lastRemoteConfigHash: remoteConfig.configHash,
      status,
      errorMessage,
    });
  }

  private _applyRemoteConfig(
    client: OpAMPPolicyClient,
    remoteConfig: AgentRemoteConfig
  ): [number, string] {
    const configMap = remoteConfig.config?.configMap ?? {};
    if (!(this._configMapKey in configMap)) {
      // Empty policy means explicitly clearing it.
      this._store.setPolicies(SourceKind.OPAMP, []);
      this._updateEffectiveConfig(client, []);
      return [RemoteConfigStatuses.RemoteConfigStatuses_APPLIED, ''];
    }

    const body = configMap[this._configMapKey].body;
    let text: string;
    let result;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      result = parsePolicyDocument(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diag.warn(
        `cannot parse remote config policy document, keeping previous policies: ${message}`
      );
      return [
        RemoteConfigStatuses.RemoteConfigStatuses_FAILED,
        `cannot parse policy document: ${message}`,
      ];
    }

    const errors = result.errors.map(
      error => `policy '${error.policyId}': ${error.message}`
    );
    const statuses = this._store.setPolicies(SourceKind.OPAMP, result.policies);
    errors.push(
      ...statuses
        .filter(status => !status.applied)
        .map(status => `policy '${status.policyId}': ${status.error}`)
    );

    const appliedIds = new Set(
      statuses.filter(status => status.applied).map(status => status.policyId)
    );
    this._updateEffectiveConfig(client, appliedPolicies(text, appliedIds));

    if (errors.length > 0) {
      return [
        RemoteConfigStatuses.RemoteConfigStatuses_FAILED,
        errors.join('; '),
      ];
    }
    return [RemoteConfigStatuses.RemoteConfigStatuses_APPLIED, ''];
  }

  private _updateEffectiveConfig(
    client: OpAMPPolicyClient,
    policies: unknown[]
  ): void {
    client.setEffectiveConfig({
      configMap: {
        configMap: {
          [this._configMapKey]: {
            body: new TextEncoder().encode(JSON.stringify({ policies })),
            contentType: 'application/json',
          },
        },
      },
    });
  }
}

/** Filter the received document to the policies that are in effect. */
function appliedPolicies(text: string, appliedIds: Set<string>): unknown[] {
  const document: unknown = JSON.parse(text);
  let rawPolicies: unknown;
  if (
    typeof document === 'object' &&
    document !== null &&
    !Array.isArray(document)
  ) {
    rawPolicies = (document as { [key: string]: unknown })['policies'] ?? [
      document,
    ];
  } else {
    rawPolicies = document;
  }
  const applied: unknown[] = [];
  for (const rawPolicy of rawPolicies as unknown[]) {
    if (
      typeof rawPolicy === 'object' &&
      rawPolicy !== null &&
      appliedIds.has((rawPolicy as { [key: string]: unknown })['id'] as string)
    ) {
      applied.push(rawPolicy);
    }
  }
  return applied;
}

export interface OpAMPPolicyProviderOptions {
  /** The URL of the OpAMP server, including the path (typically '/v1/opamp'). */
  endpoint: string;
  /** The store to push snapshots into. */
  store: PolicyStore;
  /** Attributes identifying the agent, e.g. `service.name`. */
  identifyingAttributes: Record<string, unknown>;
  /** Additional attributes describing the agent. */
  nonIdentifyingAttributes?: Record<string, unknown>;
  /**
   * Name of the OpAMP remote configuration entry to read the policy document
   * from. Unset, the entry with the empty name is read, which servers
   * commonly use when they send a single configuration.
   */
  configMapKey?: string;
  /** The approximate time between heartbeat messages. Default 30. */
  heartbeatIntervalSeconds?: number;
  /** Additional HTTP headers to include in requests. */
  headers?: Record<string, string>;
  /** Override the OpAMP client, e.g. for testing. */
  client?: OpAMPPolicyProviderClient;
}

/** Receives policy snapshots from an OpAMP server's remote config. */
export class OpAMPPolicyProvider implements PolicyProvider {
  private _client: OpAMPPolicyProviderClient;

  constructor(options: OpAMPPolicyProviderOptions) {
    const callbacks = new OpAMPPolicyCallbacks({
      store: options.store,
      configMapKey: options.configMapKey,
    });
    this._client =
      options.client ??
      createOpAMPClient({
        endpoint: options.endpoint,
        headers: options.headers,
        heartbeatIntervalSeconds: options.heartbeatIntervalSeconds,
        capabilities: BigInt(
          AgentCapabilities.AgentCapabilities_AcceptsRemoteConfig |
            AgentCapabilities.AgentCapabilities_ReportsRemoteConfig |
            AgentCapabilities.AgentCapabilities_ReportsEffectiveConfig
        ),
        onMessage: message => callbacks.onMessage(this._client, message),
      });
    this._client.setAgentDescription({
      identifyingAttributes: options.identifyingAttributes,
      nonIdentifyingAttributes: options.nonIdentifyingAttributes,
    });
  }

  public get sourceKind(): SourceKind {
    return SourceKind.OPAMP;
  }

  public start(): void {
    this._client.start();
  }

  public async shutdown(): Promise<void> {
    await this._client.shutdown();
  }
}
