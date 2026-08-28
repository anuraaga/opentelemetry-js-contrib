# OpAMP client for Node.js

[![NPM Published Version][npm-img]][npm-url]
[![Apache License][license-image]][license-url]

This package provides an experimental [OpAMP](https://opentelemetry.io/docs/specs/opamp/)
client for Node.js. It implements the plain HTTP transport (not the WebSocket
transport) and currently supports the following OpAMP capabilities:

- `ReportsStatus` (always enabled)
- `ReportsHeartbeat` (always enabled, because the HTTP transport is used)
- `AcceptsRemoteConfig`
- `ReportsRemoteConfig`
- `ReportsEffectiveConfig`

The API is not finalized; breaking changes can happen on any release.

This package is derived from [`@elastic/opamp-client-node`](https://github.com/elastic/elastic-otel-node/tree/main/packages/opamp-client-node).

## Installation

```bash
npm install --save @opentelemetry/opamp-client
```

## Usage

```js
const {createOpAMPClient, AgentCapabilities, RemoteConfigStatuses} = require('@opentelemetry/opamp-client');

const client = createOpAMPClient({
  endpoint: 'http://localhost:4320/v1/opamp',
  capabilities:
    AgentCapabilities.AgentCapabilities_AcceptsRemoteConfig |
    AgentCapabilities.AgentCapabilities_ReportsRemoteConfig,
  onMessage: ({remoteConfig}) => {
    if (remoteConfig) {
      // Apply the remote config, then report its status.
      client.setRemoteConfigStatus({
        status: RemoteConfigStatuses.RemoteConfigStatuses_APPLIED,
        lastRemoteConfigHash: remoteConfig.configHash,
      });
    }
  },
});
client.setAgentDescription({
  identifyingAttributes: {
    'service.name': 'my-service',
  },
});
client.start();

// On process shutdown:
// await client.shutdown();
```

## Useful links

- [OpAMP specification](https://opentelemetry.io/docs/specs/opamp/)
- For more information on OpenTelemetry, visit: <https://opentelemetry.io/>
- For more about OpenTelemetry JavaScript: <https://github.com/open-telemetry/opentelemetry-js>
- For help or feedback on this project, join us in [GitHub Discussions][discussions-url]

## License

Apache 2.0 - See [LICENSE][license-url] for more information.

[discussions-url]: https://github.com/open-telemetry/opentelemetry-js/discussions
[license-url]: https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/LICENSE
[license-image]: https://img.shields.io/badge/license-Apache_2.0-green.svg?style=flat
[npm-url]: https://www.npmjs.com/package/@opentelemetry/opamp-client
[npm-img]: https://badge.fury.io/js/%40opentelemetry%2Fopamp-client.svg
