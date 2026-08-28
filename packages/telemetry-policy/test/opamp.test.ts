/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';

import {
  AgentRemoteConfig,
  EffectiveConfigInput,
  RemoteConfigStatuses,
  RemoteConfigStatusInput,
} from '@opentelemetry/opamp-client';

import { SourceKind } from '../src/model';
import {
  OpAMPPolicyCallbacks,
  OpAMPPolicyClient,
  OpAMPPolicyProvider,
} from '../src/opamp';
import { PolicyStore } from '../src/store';
import { TraceSamplingPolicyImplementer } from '../src/trace-sampling';
import { currentPercentages } from './testutils';

/** Stands in for the OpAMP client; captures reported state. */
class RecordingClient implements OpAMPPolicyClient {
  statuses: RemoteConfigStatusInput[] = [];
  effectiveConfigs: EffectiveConfigInput[] = [];

  setRemoteConfigStatus(remoteConfigStatus: RemoteConfigStatusInput): void {
    this.statuses.push(remoteConfigStatus);
  }

  setEffectiveConfig(effectiveConfig: EffectiveConfigInput): void {
    this.effectiveConfigs.push(effectiveConfig);
  }
}

function policyDocument(
  percentage: number,
  extraPolicies: unknown[] = []
): Uint8Array {
  const policies: unknown[] = [
    {
      id: 'sample-database-spans',
      name: 'Sample database spans',
      trace: {
        match: [{ span_attribute: ['db.system'], exists: true }],
        keep: { percentage },
      },
    },
    ...extraPolicies,
  ];
  return new TextEncoder().encode(JSON.stringify({ policies }));
}

function remoteConfig(
  body: Uint8Array,
  configHash: Uint8Array = new TextEncoder().encode('hash-1'),
  key = ''
): AgentRemoteConfig {
  return {
    configHash,
    config: {
      configMap: {
        [key]: { body, contentType: 'application/json' },
      },
    },
  } as unknown as AgentRemoteConfig;
}

function sentStatus(client: RecordingClient): RemoteConfigStatusInput {
  assert.strictEqual(client.statuses.length, 1);
  return client.statuses[0];
}

function sentEffectivePolicyIds(client: RecordingClient, key = ''): string[] {
  assert.ok(client.effectiveConfigs.length >= 1);
  const effectiveConfig =
    client.effectiveConfigs[client.effectiveConfigs.length - 1];
  const body = effectiveConfig.configMap!.configMap[key].body;
  const document = JSON.parse(new TextDecoder().decode(body));
  return document.policies.map((policy: { id: string }) => policy.id);
}

describe('OpAMPPolicyCallbacks', () => {
  it('applies and acknowledges remote config', () => {
    const store = new PolicyStore();
    store.addImplementer(new TraceSamplingPolicyImplementer());
    const callbacks = new OpAMPPolicyCallbacks({ store });
    const client = new RecordingClient();

    callbacks.onMessage(client, {
      remoteConfig: remoteConfig(policyDocument(5.0)),
    });

    assert.deepStrictEqual(currentPercentages(store), [5.0]);
    const status = sentStatus(client);
    assert.strictEqual(
      status.status,
      RemoteConfigStatuses.RemoteConfigStatuses_APPLIED
    );
    assert.deepStrictEqual(
      Buffer.from(status.lastRemoteConfigHash),
      Buffer.from('hash-1')
    );
    assert.strictEqual(status.errorMessage, '');
    assert.deepStrictEqual(sentEffectivePolicyIds(client), [
      'sample-database-spans',
    ]);
  });

  it('reports an unchanged status identically, deduplicated by the client', () => {
    // Unlike the Python implementation, deduplicating unchanged statuses is
    // the OpAMP client's job (`setRemoteConfigStatus` only schedules a send
    // when the status changed), so here we only check that repeated messages
    // produce identical reports.
    const store = new PolicyStore();
    store.addImplementer(new TraceSamplingPolicyImplementer());
    const callbacks = new OpAMPPolicyCallbacks({ store });
    const client = new RecordingClient();

    const message = { remoteConfig: remoteConfig(policyDocument(5.0)) };
    callbacks.onMessage(client, message);
    callbacks.onMessage(client, message);

    assert.strictEqual(client.statuses.length, 2);
    assert.deepStrictEqual(client.statuses[0], client.statuses[1]);
    assert.deepStrictEqual(
      client.effectiveConfigs[0],
      client.effectiveConfigs[1]
    );
  });

  it('reports failure for an unparsable document and keeps policies', () => {
    const store = new PolicyStore();
    store.addImplementer(new TraceSamplingPolicyImplementer());
    const callbacks = new OpAMPPolicyCallbacks({ store });
    const client = new RecordingClient();
    callbacks.onMessage(client, {
      remoteConfig: remoteConfig(policyDocument(5.0)),
    });
    client.statuses = [];

    callbacks.onMessage(client, {
      remoteConfig: remoteConfig(
        new TextEncoder().encode('{ not json'),
        new TextEncoder().encode('hash-2')
      ),
    });

    assert.deepStrictEqual(currentPercentages(store), [5.0]);
    const status = sentStatus(client);
    assert.strictEqual(
      status.status,
      RemoteConfigStatuses.RemoteConfigStatuses_FAILED
    );
    assert.deepStrictEqual(
      Buffer.from(status.lastRemoteConfigHash),
      Buffer.from('hash-2')
    );
    assert.ok(status.errorMessage!.includes('cannot parse policy document'));
  });

  it('reports failure with details for a partially applied document', () => {
    const store = new PolicyStore();
    store.addImplementer(new TraceSamplingPolicyImplementer());
    const callbacks = new OpAMPPolicyCallbacks({ store });
    const client = new RecordingClient();
    const body = policyDocument(5.0, [{ id: 'missing-name' }]);

    callbacks.onMessage(client, { remoteConfig: remoteConfig(body) });

    assert.deepStrictEqual(currentPercentages(store), [5.0]);
    const status = sentStatus(client);
    assert.strictEqual(
      status.status,
      RemoteConfigStatuses.RemoteConfigStatuses_FAILED
    );
    assert.ok(status.errorMessage!.includes('missing-name'));
    // The reported effective config only contains what actually applied.
    assert.deepStrictEqual(sentEffectivePolicyIds(client), [
      'sample-database-spans',
    ]);
  });

  it('clears policies when the config map key is missing', () => {
    const store = new PolicyStore();
    store.addImplementer(new TraceSamplingPolicyImplementer());
    const callbacks = new OpAMPPolicyCallbacks({ store });
    const client = new RecordingClient();
    callbacks.onMessage(client, {
      remoteConfig: remoteConfig(policyDocument(5.0)),
    });
    client.statuses = [];

    callbacks.onMessage(client, {
      remoteConfig: remoteConfig(
        policyDocument(5.0),
        new TextEncoder().encode('hash-2'),
        'other'
      ),
    });

    assert.deepStrictEqual(currentPercentages(store), []);
    assert.strictEqual(
      sentStatus(client).status,
      RemoteConfigStatuses.RemoteConfigStatuses_APPLIED
    );
    assert.deepStrictEqual(sentEffectivePolicyIds(client), []);
  });

  it('reads a configured config map key', () => {
    const store = new PolicyStore();
    store.addImplementer(new TraceSamplingPolicyImplementer());
    const callbacks = new OpAMPPolicyCallbacks({
      store,
      configMapKey: 'vendor',
    });
    const client = new RecordingClient();

    callbacks.onMessage(client, {
      remoteConfig: remoteConfig(
        policyDocument(5.0),
        new TextEncoder().encode('hash-1'),
        'vendor'
      ),
    });

    assert.deepStrictEqual(currentPercentages(store), [5.0]);
    assert.deepStrictEqual(sentEffectivePolicyIds(client, 'vendor'), [
      'sample-database-spans',
    ]);
  });

  it('ignores a message without remote config', () => {
    const store = new PolicyStore();
    const callbacks = new OpAMPPolicyCallbacks({ store });
    const client = new RecordingClient();

    callbacks.onMessage(client, {});

    assert.strictEqual(client.statuses.length, 0);
    assert.strictEqual(client.effectiveConfigs.length, 0);
  });
});

describe('OpAMPPolicyProvider', () => {
  it('constructs and shuts down', async () => {
    const store = new PolicyStore();
    const provider = new OpAMPPolicyProvider({
      endpoint: 'http://localhost:4320/v1/opamp',
      store,
      identifyingAttributes: { 'service.name': 'test-service' },
      nonIdentifyingAttributes: { 'deployment.environment.name': 'test' },
    });

    assert.strictEqual(provider.sourceKind, SourceKind.OPAMP);
    await provider.shutdown();
  });
});
