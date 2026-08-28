/*
 * Copyright The OpenTelemetry Authors
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// A mock OpAMP server for tests, derived from the `@elastic/mockopampserver`
// package in https://github.com/elastic/elastic-otel-node. Compared to that
// package this is trimmed down to what the tests in this repository need:
// no TLS, no gzip handling, no HTTP test API, no logging.

const assert = require('assert');
const http = require('http');
const { createHash } = require('crypto');
const { inspect } = require('util');

const { create, toBinary, fromBinary } = require('@bufbuild/protobuf');
const { stringify: uuidStringify } = require('uuid');

const {
  AgentToServerSchema,
  ServerToAgentSchema,
  ServerToAgentFlags,
  ServerCapabilities,
  AgentCapabilities,
  ServerErrorResponseType,
} = require('../lib/generated/opamp_pb.js');
const { objFromKeyValues, isEqualUint8Array } = require('../lib/utils');

/**
 * @typedef {import('../lib/generated/opamp_pb.js').AgentToServer} AgentToServer
 * @typedef {import('../lib/generated/opamp_pb.js').ServerToAgent} ServerToAgent
 * @typedef {import('../lib/generated/opamp_pb.js').AgentConfigMap} AgentConfigMap
 */

const DEFAULT_ENDPOINT_PATH = '/v1/opamp';

const BAD_MODES = [
  // Responds to valid AgentToServer requests with a ServerToAgent payload
  // with a ServerErrorResponse of type UNKNOWN.
  'server_error_response_unknown',
  // Responds to valid AgentToServer requests with a ServerToAgent payload
  // with a ServerErrorResponse of type UNAVAILABLE and
  // retryAfterNanoseconds of 42e9 (i.e. 42 seconds).
  'server_error_response_unavailable',
];

/**
 * @param {http.ServerResponse} res
 */
function respondHttpErr(res, errMsg = 'Bad Request', errCode = 400) {
  res.writeHead(errCode, {
    'Content-Type': 'text/plain',
  });
  res.end(errMsg);
}

/**
 * AFAICT the OpAMP spec doesn't specify how to create this hash, but that's
 * fine.
 *
 * @param {AgentConfigMap} agentConfigMap
 * @return {Uint8Array}
 */
function hashAgentConfigMap(agentConfigMap) {
  const hash = createHash('sha256');
  const keys = Object.keys(agentConfigMap.configMap);
  keys.sort();
  keys.forEach(key => {
    hash.update(key);
    hash.update('\0');
    const agentConfigFile = agentConfigMap.configMap[key];
    hash.update(agentConfigFile.contentType);
    hash.update('\0');
    hash.update(agentConfigFile.body);
    hash.update('\0');
  });
  return hash.digest();
}

/**
 * A data class to store info about agents this server has seen.
 */
class AgentInfo {
  constructor(data) {
    this.instanceUidStr = data.instanceUidStr;
    this.instanceUid = data.instanceUid;
    this.sequenceNum = data.sequenceNum;
    this.capabilities = data.capabilities;
    this.agentDescription = data.agentDescription;
    this.remoteConfigStatus = data.remoteConfigStatus;
    this.effectiveConfig = data.effectiveConfig;
    this.lastMsgTime = data.lastMsgTime;
  }

  /**
   * Return a JS object representation of `agentDescription.identifyingAttributes`.
   */
  getIdentifyingAttributes() {
    return objFromKeyValues(this.agentDescription.identifyingAttributes);
  }

  /**
   * Return a JS object representation of `agentDescription.nonIdentifyingAttributes`.
   */
  getNonIdentifyingAttributes() {
    return objFromKeyValues(this.agentDescription.nonIdentifyingAttributes);
  }

  [inspect.custom](depth, options, inspect) {
    const subset = {
      instanceUidStr: this.instanceUidStr,
      sequenceNum: this.sequenceNum,
      capabilities: this.capabilities,
      agentDescription_: {
        identifyingAttributes: objFromKeyValues(
          this.agentDescription?.identifyingAttributes
        ),
        nonIdentifyingAttributes: objFromKeyValues(
          this.agentDescription?.nonIdentifyingAttributes
        ),
      },
      remoteConfigStatus: this.remoteConfigStatus,
      lastMsgTime: this.lastMsgTime,
    };
    return `AgentInfo ${inspect(subset, { ...options, depth: 10 })}`;
  }
}

class MockOpAMPServer {
  /**
   * @param {object} [opts]
   * @param {string} [opts.hostname] Default '127.0.0.1'.
   * @param {number} [opts.port] A port on which to listen. Default 0.
   * @param {AgentConfigMap} [opts.agentConfigMap] An optional config map
   *      to offer to clients with the `AcceptsRemoteConfig` capability.
   *      For example:
   *          const config = {foo: 42};
   *          const body = Buffer.from(JSON.stringify(config), 'utf8');
   *          const agentConfigMap = {
   *              configMap: {
   *                  '': {body, contentType: 'application/json'}
   *              }
   *          };
   * @param {string} [opts.badMode] Enable a specific "bad" mode where the
   *      server responds in various bad ways. See `BAD_MODES` for supported
   *      values of `badMode`.
   */
  constructor(opts) {
    opts = opts ?? {};

    this._hostname = opts.hostname ?? '127.0.0.1';
    this._port = opts.port ?? 0;
    this._endpointPath = DEFAULT_ENDPOINT_PATH;
    if (opts.agentConfigMap) {
      this.setAgentConfigMap(opts.agentConfigMap);
    }
    this._server = http.createServer(this._onRequest.bind(this));
    this._started = false;

    /** @type {Map<string, AgentInfo>} */
    this._activeAgents = new Map();
    this._testRequests = [];

    if (opts.badMode) {
      if (!BAD_MODES.includes(opts.badMode)) {
        throw new Error(`unknown "badMode" value: "${opts.badMode}"`);
      }
      this._badMode = opts.badMode;
    }
  }

  /**
   * Set the data used by the server to provide `remoteConfig` to agents.
   */
  setAgentConfigMap(agentConfigMap) {
    this._agentConfigMap = agentConfigMap;
    this._agentConfigMapHash = hashAgentConfigMap(agentConfigMap);
  }

  get endpoint() {
    assert.ok(
      this._started,
      'MockOpAMPServer must be started to have an `endpoint`.'
    );
    return this._endpoint;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this._server.listen(this._port, this._hostname, () => {
        const addr = this._server.address();
        if (addr.family === 'IPv6') {
          this._endpointOrigin = `http://[${addr.address}]:${addr.port}`;
        } else {
          this._endpointOrigin = `http://${addr.address}:${addr.port}`;
        }
        this._endpoint = this._endpointOrigin + this._endpointPath;
        resolve();
      });
      this._server.on('error', reject);
      this._started = true;
    });
  }

  async close() {
    if (this._started) {
      return new Promise((resolve, reject) => {
        this._server.close(err => {
          err ? reject(err) : resolve();
        });
      });
    }
  }

  /**
   * Lookup an agent by `instanceUid`.
   *
   * @param {Uint8Array} instanceUid
   * @returns {AgentInfo | undefined}
   */
  getActiveAgent(instanceUid) {
    const instanceUidStr = uuidStringify(instanceUid);
    return this._activeAgents.get(instanceUidStr);
  }

  /**
   * Clear any cached data. This is useful when starting a test.
   */
  testReset() {
    this._activeAgents.clear();
    this._testRequests = [];
  }

  /**
   * Return a (shallow) copy of received requests.
   *
   * This returns an array of objects of the form:
   *      {
   *          req: <incoming HTTP request>,
   *          a2s: <AgentToServer protobuf message>,
   *          res: <outgoing HTTP response>,
   *          s2a: <ServerToAgent protobuf message>,
   *          err: <Error instance if there was an error>,
   *      }
   * If a request fails, some of these fields will not be present.
   */
  testGetRequests() {
    return this._testRequests.slice();
  }

  _testNoteRequest({
    req,
    res = undefined,
    a2s = undefined,
    s2a = undefined,
    err = undefined,
  }) {
    function pick(obj, propNames) {
      if (obj === undefined) {
        return undefined;
      }
      const picked = {};
      for (let n of propNames) {
        if (n in obj) {
          picked[n] = obj[n];
        }
      }
      return picked;
    }

    this._testRequests.push({
      req: pick(req, ['method', 'path', 'headers']),
      res: pick(res, ['statusCode', '_header']),
      a2s,
      s2a,
      err,
    });
  }

  _onRequest(req, res) {
    const u = new URL(req.url, this._endpointOrigin);

    // Basic HTTP request validations.
    if (u.pathname !== this._endpointPath) {
      respondHttpErr(res, '404 page not found', 404);
      this._testNoteRequest({ req, res });
      return;
    }
    if (req.method !== 'POST') {
      respondHttpErr(res);
      this._testNoteRequest({ req, res });
      return;
    }
    if (req.headers['content-type'] !== 'application/x-protobuf') {
      respondHttpErr(
        res,
        `invalid Content-Type, expect "application/x-protobuf", got ${
          req.headers['content-type'] ?? '<empty>'
        }`
      );
      this._testNoteRequest({ req, res });
      return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', err => {
      respondHttpErr(res, err.message);
      this._testNoteRequest({ req, res, err });
    });
    req.on('end', () => {
      const reqBuffer = Buffer.concat(chunks);
      let a2s;
      try {
        a2s = fromBinary(AgentToServerSchema, reqBuffer);
      } catch (err) {
        respondHttpErr(res, err.message);
        this._testNoteRequest({ req, res, err });
        return;
      }

      if (a2s.instanceUid.length !== 16) {
        respondHttpErr(
          res,
          `invalid length of instanceUid: ${a2s.instanceUid.length}`
        );
        this._testNoteRequest({ req, res, a2s });
        return;
      }

      let s2a;
      if (this._badMode === 'server_error_response_unknown') {
        s2a = create(ServerToAgentSchema, {
          instanceUid: a2s.instanceUid,
          errorResponse: {
            type: ServerErrorResponseType.ServerErrorResponseType_Unknown,
            errorMessage: 'some unknown error',
          },
        });
      } else if (this._badMode === 'server_error_response_unavailable') {
        s2a = create(ServerToAgentSchema, {
          instanceUid: a2s.instanceUid,
          errorResponse: {
            type: ServerErrorResponseType.ServerErrorResponseType_Unavailable,
            errorMessage: 'some reason',
            Details: {
              case: 'retryInfo',
              value: {
                retryAfterNanoseconds: 42_000_000_000n,
              },
            },
          },
        });
      } else {
        try {
          s2a = this._processAgentToServer(a2s);
        } catch (err) {
          respondHttpErr(
            res,
            `could not process AgentToServer: ${err.message}`,
            500
          );
          this._testNoteRequest({ req, res, a2s, err });
          return;
        }
      }

      const resBody = toBinary(ServerToAgentSchema, s2a);
      res.writeHead(200, {
        'Content-Type': 'application/x-protobuf',
        'Content-Length': resBody.length,
      });
      res.end(resBody);
      this._testNoteRequest({ req, res, a2s, s2a });
    });
  }

  /**
   * @param {AgentToServer} a2s
   * @returns {ServerToAgent}
   */
  _processAgentToServer(a2s) {
    let instanceUidStr;
    try {
      instanceUidStr = uuidStringify(a2s.instanceUid);
    } catch (err) {
      throw new Error(
        `could not stringify 'instanceUid' to a UUID: err="${
          err.message
        }", a2s.instanceUid=${inspect(Buffer.from(a2s.instanceUid))}`
      );
    }
    const reportedFullState = Boolean(
      a2s.agentDescription &&
        (!(
          a2s.capabilities &
          BigInt(AgentCapabilities.AgentCapabilities_ReportsRemoteConfig)
        ) ||
          a2s.remoteConfigStatus)
    );
    const resData = {
      instanceUid: a2s.instanceUid,
      flags: 0,
      capabilities:
        ServerCapabilities.ServerCapabilities_AcceptsStatus |
        ServerCapabilities.ServerCapabilities_OffersRemoteConfig,
    };

    // Create or update an agent record for this agent. Also decide if
    // need to request ReportFullState.
    let agent = this._activeAgents.get(instanceUidStr);
    if (!agent) {
      agent = new AgentInfo({
        instanceUidStr,
        instanceUid: a2s.instanceUid,
        sequenceNum: a2s.sequenceNum,
        capabilities: a2s.capabilities,
        agentDescription: a2s.agentDescription,
        remoteConfigStatus: a2s.remoteConfigStatus,
        effectiveConfig: a2s.effectiveConfig,
        lastMsgTime: Date.now(),
      });
      this._activeAgents.set(instanceUidStr, agent);
      if (!reportedFullState) {
        resData.flags |= ServerToAgentFlags.ServerToAgentFlags_ReportFullState;
      }
    } else {
      if (a2s.sequenceNum !== agent.sequenceNum + 1n && !reportedFullState) {
        resData.flags |= ServerToAgentFlags.ServerToAgentFlags_ReportFullState;
      }
      agent.sequenceNum = a2s.sequenceNum;
      agent.capabilities = a2s.capabilities;
      if (a2s.agentDescription) {
        agent.agentDescription = a2s.agentDescription;
      }
      if (a2s.remoteConfigStatus) {
        agent.remoteConfigStatus = a2s.remoteConfigStatus;
      }
      if (a2s.effectiveConfig) {
        agent.effectiveConfig = a2s.effectiveConfig;
      }
      agent.lastMsgTime = Date.now();
      this._activeAgents.set(instanceUidStr, agent);
    }

    // Offer remote config, if:
    // - the agent accepts remote config
    // - the server has remote config for this agent
    // - the RemoteConfigStatus.lastRemoteConfigHash differs, if have
    //   remoteConfigStatus from the agent
    const acceptsRemoteConfig =
      a2s.capabilities &
      BigInt(AgentCapabilities.AgentCapabilities_AcceptsRemoteConfig);
    if (
      acceptsRemoteConfig &&
      this._agentConfigMap &&
      (!agent.remoteConfigStatus ||
        !isEqualUint8Array(
          agent.remoteConfigStatus.lastRemoteConfigHash,
          this._agentConfigMapHash
        ))
    ) {
      resData.remoteConfig = {
        config: this._agentConfigMap,
        configHash: this._agentConfigMapHash,
      };
    }

    return create(ServerToAgentSchema, resData);
  }
}

module.exports = {
  MockOpAMPServer,
};
