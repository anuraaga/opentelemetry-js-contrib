/*
 * Copyright The OpenTelemetry Authors
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const assert = require('assert');

const {
  createOpAMPClient,
  RemoteConfigStatuses,
  AgentCapabilities,
  DIAG_CH_SEND_SUCCESS,
  DIAG_CH_SEND_FAIL,
} = require('..');
const { objFromKeyValues, isEqualUint8Array } = require('../lib/utils');
const { MockOpAMPServer } = require('./mockopampserver');
const { barrierNDiagEvents } = require('./testutils');

describe('OpAMPClient', () => {
  it('minimal usage', async () => {
    const opampServer = new MockOpAMPServer();
    await opampServer.start();

    // Minimal usage of the OpAMP client.
    const client = createOpAMPClient({
      endpoint: opampServer.endpoint,
      diagEnabled: true,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    const instanceUid = client.getInstanceUid();
    client.start();

    // Wait until the client request/response has completed. The OpAMPClient
    // supports a diagnostics_channel-based feature to watch its
    // interactions. The 3 expected events: send.schedule, send.success,
    // send.schedule.
    await barrierNDiagEvents(3);

    const reqs = opampServer.testGetRequests();
    assert.strictEqual(reqs.length, 1);

    assert.ok(isEqualUint8Array(instanceUid, reqs[0].a2s.instanceUid));
    assert.strictEqual(reqs[0].a2s.sequenceNum, 1n);
    assert.deepStrictEqual(
      objFromKeyValues(reqs[0].a2s.agentDescription.identifyingAttributes),
      { foo: 'bar' }
    );

    assert.ok(isEqualUint8Array(instanceUid, reqs[0].s2a.instanceUid));
    assert.strictEqual(
      Number(reqs[0].s2a.flags),
      0,
      'ServerToAgent did not set ReportFullState flag'
    );

    await client.shutdown();
    await opampServer.close();
  });

  it('client.setAgentDescription', async () => {
    const server = new MockOpAMPServer();
    await server.start();

    const client = createOpAMPClient({
      endpoint: server.endpoint,
      diagEnabled: true,
    });
    const desc = {
      identifyingAttributes: {
        'service.name': 'foo-bar',
      },
      // Exercise the various value types.
      nonIdentifyingAttributes: {
        aStr: 'strVal',
        aBool: true,
        aBool2: false,
        anInt: 42,
        aFloat: 3.141,
        aBigInt: 1152921504606846976n, // less than 2**64, bigger than MAX_SAFE_INTEGER
        aBuffer: Buffer.from([1, 2, 3]),
        anArray: [1, 2, 3, 'a', 'b', 'c', { spam: 'eggs' }],
        anObj: { foo: 'bar', baz: 'blam' },
      },
    };
    const instanceUid = client.getInstanceUid();
    client.setAgentDescription(desc);
    client.start();

    // events: 1. send.schedule, 2. send.success, 3. send.schedule.
    await barrierNDiagEvents(3);

    const serverAgentInfo = server.getActiveAgent(instanceUid);
    assert.ok(serverAgentInfo);
    assert.deepStrictEqual(
      serverAgentInfo.getIdentifyingAttributes(),
      desc.identifyingAttributes
    );
    assert.deepStrictEqual(
      serverAgentInfo.getNonIdentifyingAttributes(),
      desc.nonIdentifyingAttributes
    );

    // Test changing the description again:
    // - Ensure the server gets the update, and
    // - ensure a Uint8Array value works, which is more finnicky to test
    //   because it gets translated to a `Buffer` by bufbuild (the protobuf
    //   lib).
    const desc2 = {
      identifyingAttributes: desc.identifyingAttributes,
      nonIdentifyingAttributes: {
        aUint8Array: new Uint8Array([4, 5, 6]),
      },
    };
    client.setAgentDescription(desc2);
    await barrierNDiagEvents(2); // events: 1. send.success, 2. send.schedule
    const serverAgentInfo2 = server.getActiveAgent(instanceUid);
    assert.ok(serverAgentInfo2);
    assert.deepStrictEqual(
      serverAgentInfo2.getIdentifyingAttributes(),
      desc2.identifyingAttributes
    );
    const nia2 = serverAgentInfo2.getNonIdentifyingAttributes();
    assert.strictEqual(Object.keys(nia2).length, 1);
    assert.ok(
      isEqualUint8Array(
        nia2.aUint8Array, // Buffer
        desc2.nonIdentifyingAttributes.aUint8Array // Uint8Array
      ),
      'aUint8Array attribute matches'
    );

    await client.shutdown();
    await server.close();
  });

  it('client.{set,reset}HeartbeatIntervalSeconds', async () => {
    const server = new MockOpAMPServer();
    await server.start();

    const client = createOpAMPClient({
      endpoint: server.endpoint,
      heartbeatIntervalSeconds: 0.5,
      diagEnabled: true,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();

    // Cheating a bit by testing a private attribute.
    assert.strictEqual(client._heartbeatIntervalMs, 500, 'initial value');

    client.setHeartbeatIntervalSeconds(1);
    assert.strictEqual(client._heartbeatIntervalMs, 1000, 'valid value works');

    client.setHeartbeatIntervalSeconds(0.01);
    assert.strictEqual(
      client._heartbeatIntervalMs,
      1000,
      'too low value ignored'
    );

    client.setHeartbeatIntervalSeconds(0.1);
    assert.strictEqual(client._heartbeatIntervalMs, 100, 'min value works');

    client.setHeartbeatIntervalSeconds('bogus');
    assert.strictEqual(
      client._heartbeatIntervalMs,
      100,
      'invalid type is ignored'
    );

    const DAY_IN_S = 86400;
    client.setHeartbeatIntervalSeconds(DAY_IN_S * 2);
    assert.strictEqual(
      client._heartbeatIntervalMs,
      DAY_IN_S * 1000,
      'too large value is clamped to 1d'
    );

    client.resetHeartbeatIntervalSeconds();
    assert.strictEqual(
      client._heartbeatIntervalMs,
      500, // the initial value
      'resetHeartbeatIntervalSeconds works'
    );

    await client.shutdown();
    await server.close();
  });

  it('remote config', async () => {
    // Setup MockOpAMPServer to provide `config` as remote config.
    const config = { foo: 42 };
    const opampServer = new MockOpAMPServer({
      agentConfigMap: {
        configMap: {
          '': {
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify(config), 'utf8'),
          },
        },
      },
    });
    await opampServer.start();

    // Setup OpAMPClient to receive remote config and report its status.
    let numOnMessageCalls = 0;
    let receivedRemoteConfig = null;
    const client = createOpAMPClient({
      endpoint: opampServer.endpoint,
      diagEnabled: true,
      heartbeatIntervalSeconds: 1, // reduce from 30 for a faster test
      capabilities:
        AgentCapabilities.AgentCapabilities_AcceptsRemoteConfig |
        AgentCapabilities.AgentCapabilities_ReportsRemoteConfig,
      onMessage: ({ remoteConfig }) => {
        receivedRemoteConfig = remoteConfig;
        numOnMessageCalls += 1;
        client.setRemoteConfigStatus({
          status: RemoteConfigStatuses.RemoteConfigStatuses_APPLIED,
          lastRemoteConfigHash: remoteConfig.configHash,
        });
      },
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();

    // Expected interaction:
    //  - soon after start:
    //    AgentToServer: "Hello, my name is Bob."
    //    ServerToAgent: "Bob, here is some remote config."
    //  - soon after:
    //    AgentToServer: "Remote config APPLIED."
    //    ServerToAgent: (minimal empty response)
    //  - after next heartbeat interval
    //    AgentToServer: (minimal empty heartbeat)
    //    ServerToAgent: (minimal empty response)
    // Checking that last request ensures that ReportRemoteConfig is working
    // to reduce the noise of re-sending the same config all the time.

    await barrierNDiagEvents(3, [DIAG_CH_SEND_SUCCESS, DIAG_CH_SEND_FAIL]);
    const reqs = opampServer.testGetRequests();

    // The client received the expected remote config:
    assert.strictEqual(numOnMessageCalls, 1);
    assert.ok(receivedRemoteConfig);
    const agentConfigFile = receivedRemoteConfig.config.configMap[''];
    assert.strictEqual(agentConfigFile.contentType, 'application/json');
    const receivedConfig = JSON.parse(
      new TextDecoder().decode(agentConfigFile.body)
    );
    assert.deepStrictEqual(receivedConfig, config);

    // The client subsequently sent a RemoteConfigStatus.
    const sentStatus = reqs[1].a2s.remoteConfigStatus;
    assert.ok(sentStatus);
    assert.strictEqual(
      sentStatus.status,
      RemoteConfigStatuses.RemoteConfigStatuses_APPLIED
    );
    assert.ok(
      isEqualUint8Array(
        sentStatus.lastRemoteConfigHash,
        receivedRemoteConfig.configHash
      ),
      'remote config hashes match'
    );

    // The third request/response was minimal.
    assert.strictEqual(reqs.length, 3);
    assert.deepStrictEqual(Object.keys(reqs[2].a2s), [
      '$typeName',
      'instanceUid',
      'sequenceNum',
      'capabilities',
      'flags',
    ]);
    assert.deepStrictEqual(Object.keys(reqs[2].s2a), [
      '$typeName',
      'instanceUid',
      'flags',
      'capabilities',
    ]);

    await client.shutdown();
    await opampServer.close();
  });

  it('remote config: error status', async () => {
    // Setup MockOpAMPServer to provide `config` as remote config.
    const config = { foo: 42 };
    const opampServer = new MockOpAMPServer({
      agentConfigMap: {
        configMap: {
          '': {
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify(config), 'utf8'),
          },
        },
      },
    });
    await opampServer.start();

    // Setup OpAMPClient to receive remote config and report an error
    // status in applying it.
    let numOnMessageCalls = 0;
    let receivedRemoteConfig = null;
    const client = createOpAMPClient({
      endpoint: opampServer.endpoint,
      diagEnabled: true,
      heartbeatIntervalSeconds: 1, // reduce from 30 for a faster test
      capabilities:
        AgentCapabilities.AgentCapabilities_AcceptsRemoteConfig |
        AgentCapabilities.AgentCapabilities_ReportsRemoteConfig,
      onMessage: ({ remoteConfig }) => {
        receivedRemoteConfig = remoteConfig;
        numOnMessageCalls += 1;
        setTimeout(() => {
          client.setRemoteConfigStatus({
            status: RemoteConfigStatuses.RemoteConfigStatuses_FAILED,
            lastRemoteConfigHash: remoteConfig.configHash,
            errorMessage: 'some error message',
          });
        }, 100);
      },
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    client.start();

    await barrierNDiagEvents(3, [DIAG_CH_SEND_SUCCESS, DIAG_CH_SEND_FAIL]);
    const reqs = opampServer.testGetRequests();

    // The client received the expected remote config:
    assert.strictEqual(numOnMessageCalls, 1);
    assert.ok(receivedRemoteConfig);
    const agentConfigFile = receivedRemoteConfig.config.configMap[''];
    assert.strictEqual(agentConfigFile.contentType, 'application/json');
    const receivedConfig = JSON.parse(
      new TextDecoder().decode(agentConfigFile.body)
    );
    assert.deepStrictEqual(receivedConfig, config);

    // The client subsequently sent a RemoteConfigStatus.
    const sentStatus = reqs[1].a2s.remoteConfigStatus;
    assert.ok(sentStatus);
    assert.strictEqual(
      sentStatus.status,
      RemoteConfigStatuses.RemoteConfigStatuses_FAILED
    );

    // The server has that updated RemoteConfigStatus.
    const aa = opampServer.getActiveAgent(client.getInstanceUid());
    assert.strictEqual(
      aa.remoteConfigStatus.status,
      RemoteConfigStatuses.RemoteConfigStatuses_FAILED
    );
    assert.strictEqual(
      aa.remoteConfigStatus.errorMessage,
      'some error message'
    );

    // The third request/response was minimal, i.e. we are in a steady
    // state of heartbeating.
    assert.deepStrictEqual(Object.keys(reqs[2].a2s), [
      '$typeName',
      'instanceUid',
      'sequenceNum',
      'capabilities',
      'flags',
    ]);
    assert.deepStrictEqual(Object.keys(reqs[2].s2a), [
      '$typeName',
      'instanceUid',
      'flags',
      'capabilities',
    ]);

    await client.shutdown();
    await opampServer.close();
  });

  it('client.setEffectiveConfig', async () => {
    const opampServer = new MockOpAMPServer();
    await opampServer.start();

    const client = createOpAMPClient({
      endpoint: opampServer.endpoint,
      diagEnabled: true,
      capabilities: AgentCapabilities.AgentCapabilities_ReportsEffectiveConfig,
    });
    client.setAgentDescription({ identifyingAttributes: { foo: 'bar' } });
    const effectiveConfig = {
      configMap: {
        configMap: {
          '': {
            body: Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8'),
            contentType: 'application/json',
          },
        },
      },
    };
    client.setEffectiveConfig(effectiveConfig);
    client.start();

    // events: 1. send.schedule, 2. send.success, 3. send.schedule.
    await barrierNDiagEvents(3);

    // The first message includes the effective config.
    const reqs = opampServer.testGetRequests();
    assert.strictEqual(reqs.length, 1);
    const sentConfigFile = reqs[0].a2s.effectiveConfig.configMap.configMap[''];
    assert.strictEqual(sentConfigFile.contentType, 'application/json');
    assert.deepStrictEqual(
      JSON.parse(new TextDecoder().decode(sentConfigFile.body)),
      { foo: 'bar' }
    );

    // Setting an unchanged effective config does not schedule a send.
    client.setEffectiveConfig(effectiveConfig);
    assert.strictEqual(client._queue.length, 0);

    // A changed effective config is sent to the server.
    client.setEffectiveConfig({
      configMap: {
        configMap: {
          '': {
            body: Buffer.from(JSON.stringify({ foo: 'baz' }), 'utf8'),
            contentType: 'application/json',
          },
        },
      },
    });
    // events: 1. send.success, 2. send.schedule.
    await barrierNDiagEvents(2);
    const agentInfo = opampServer.getActiveAgent(client.getInstanceUid());
    const updatedConfigFile = agentInfo.effectiveConfig.configMap.configMap[''];
    assert.deepStrictEqual(
      JSON.parse(new TextDecoder().decode(updatedConfigFile.body)),
      { foo: 'baz' }
    );

    await client.shutdown();
    await opampServer.close();
  });

  it('setEffectiveConfig requires the ReportsEffectiveConfig capability', async () => {
    const client = createOpAMPClient({
      endpoint: 'http://127.0.0.1:4320/v1/opamp',
    });
    assert.throws(() => {
      client.setEffectiveConfig({ configMap: { configMap: {} } });
    }, /ReportsEffectiveConfig/);
    await client.shutdown();
  });
});
