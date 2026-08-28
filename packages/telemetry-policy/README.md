# OpenTelemetry Telemetry Policy

[![NPM Published Version][npm-img]][npm-url]
[![Apache License][license-image]][license-url]

Experimental implementation of the telemetry policy concept proposed in
[OTEP 4738](https://github.com/open-telemetry/opentelemetry-specification/blob/main/oteps/4738-telemetry-policy.md):
policy rules distributed centrally to apply to a running SDK.

The only policy target implemented today is trace sampling, applied through a
runtime-swappable sampler. Policies are supplied by a local file provider or
by an OpAMP server's remote config (via `@opentelemetry/opamp-client`).

The API is not finalized; breaking changes can happen on any release.

## Installation

```bash
npm install --save @opentelemetry/telemetry-policy
```

## Usage

Configure the SDK with the telemetry policy sampler, and start the policy
providers configured through environment variables:

```js
const {NodeSDK} = require('@opentelemetry/sdk-node');
const {
  getTelemetryPolicySampler,
  startTelemetryPolicyProviders,
} = require('@opentelemetry/telemetry-policy');

const sdk = new NodeSDK({
  sampler: getTelemetryPolicySampler(),
  // ...
});
sdk.start();
// `resource` identifies the agent to an OpAMP server.
startTelemetryPolicyProviders(resource);
```

Then point a provider at a policy source:

```bash
# policies from a local file, polled for changes
export OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE=/etc/otel/policies.json
# and/or policies from an OpAMP server's remote config
export OTEL_NODE_EXPERIMENTAL_OPAMP_ENDPOINT=http://localhost:4320/v1/opamp
```

Or wire the pieces together programmatically:

```js
const {
  FilePolicyProvider,
  PolicyStore,
  TraceSamplingPolicyImplementer,
} = require('@opentelemetry/telemetry-policy');

const implementer = new TraceSamplingPolicyImplementer();
// Pass `implementer.sampler` as the SDK's sampler.

const store = new PolicyStore();
store.addImplementer(implementer);
const provider = new FilePolicyProvider({path: 'policies.json', store});
provider.start();
```

### Environment variables

| Variable | Description |
| -------- | ----------- |
| `OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE` | Path to a local policy document file. Setting it enables the file policy provider. |
| `OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_FILE_POLL_INTERVAL` | Milliseconds between policy file change checks (default 30000; 0 reads once). |
| `OTEL_NODE_EXPERIMENTAL_OPAMP_ENDPOINT` | OpAMP server URL. Setting it enables the OpAMP policy provider. |
| `OTEL_NODE_EXPERIMENTAL_TELEMETRY_POLICY_OPAMP_KEY` | Name of the OpAMP remote configuration entry to read the policy document from. Unset, the entry with the empty name is read. |

## Useful links

- [OTEP 4738: Telemetry Policy](https://github.com/open-telemetry/opentelemetry-specification/blob/main/oteps/4738-telemetry-policy.md)
- For more information on OpenTelemetry, visit: <https://opentelemetry.io/>
- For more about OpenTelemetry JavaScript: <https://github.com/open-telemetry/opentelemetry-js>
- For help or feedback on this project, join us in [GitHub Discussions][discussions-url]

## License

Apache 2.0 - See [LICENSE][license-url] for more information.

[discussions-url]: https://github.com/open-telemetry/opentelemetry-js/discussions
[license-url]: https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/LICENSE
[license-image]: https://img.shields.io/badge/license-Apache_2.0-green.svg?style=flat
[npm-url]: https://www.npmjs.com/package/@opentelemetry/telemetry-policy
[npm-img]: https://badge.fury.io/js/%40opentelemetry%2Ftelemetry-policy.svg
