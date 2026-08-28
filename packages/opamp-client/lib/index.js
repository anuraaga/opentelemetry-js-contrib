/*
 * Copyright The OpenTelemetry Authors
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const {
  DIAG_CH_SEND_SUCCESS,
  DIAG_CH_SEND_FAIL,
  DIAG_CH_SEND_SCHEDULE,
  USER_AGENT,
  createOpAMPClient,
} = require('./opamp-client');
const {
  AgentCapabilities,
  RemoteConfigStatuses,
} = require('./generated/opamp_pb');

// Re-export some types.
/**
 * @typedef {import('./opamp-client').OpAMPClientOptions} OpAMPClientOptions
 * @typedef {import('./opamp-client').OnMessageData} OnMessageData
 * @typedef {import('./opamp-client').RemoteConfigStatusInput} RemoteConfigStatusInput
 * @typedef {import('./opamp-client').EffectiveConfigInput} EffectiveConfigInput
 * @typedef {import('./generated/opamp_pb.js').AgentRemoteConfig} AgentRemoteConfig
 * @typedef {import('./generated/opamp_pb.js').AgentConfigMap} AgentConfigMap
 * @typedef {import('./generated/opamp_pb.js').EffectiveConfig} EffectiveConfig
 * @typedef {import('./generated/opamp_pb.js').RemoteConfigStatus} RemoteConfigStatus
 */

module.exports = {
  DIAG_CH_SEND_SUCCESS,
  DIAG_CH_SEND_FAIL,
  DIAG_CH_SEND_SCHEDULE,
  USER_AGENT,
  createOpAMPClient,

  // Re-exports of some protobuf classes/enums as needed for usage.
  AgentCapabilities,
  RemoteConfigStatuses,
};
