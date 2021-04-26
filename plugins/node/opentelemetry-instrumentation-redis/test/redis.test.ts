/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  SpanStatusCode,
  context,
  SpanKind,
  SpanStatus,
  getSpan,
  setSpan,
} from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/node';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import * as testUtils from '@opentelemetry/test-utils';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/tracing';
import * as assert from 'assert';
import { RedisInstrumentation } from '../src';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';

const instrumentation = new RedisInstrumentation();
instrumentation.enable();
instrumentation.disable();

import * as redisTypes from 'redis';

const memoryExporter = new InMemorySpanExporter();

const CONFIG = {
  host: process.env.OPENTELEMETRY_REDIS_HOST || 'localhost',
  port: process.env.OPENTELEMETRY_REDIS_PORT || '63790',
};

const URL = `redis://${CONFIG.host}:${CONFIG.port}`;

const DEFAULT_ATTRIBUTES = {
  [SemanticAttributes.DB_SYSTEM]: RedisInstrumentation.COMPONENT,
  [SemanticAttributes.NET_PEER_NAME]: CONFIG.host,
  [SemanticAttributes.NET_PEER_PORT]: CONFIG.port,
  [SemanticAttributes.NET_PEER_IP]: URL,
};

const unsetStatus: SpanStatus = {
  code: SpanStatusCode.UNSET,
};

describe('redis@2.x', () => {
  const provider = new NodeTracerProvider();
  const tracer = provider.getTracer('external');
  let redis: typeof redisTypes;
  const shouldTestLocal = process.env.RUN_REDIS_TESTS_LOCAL;
  const shouldTest = process.env.RUN_REDIS_TESTS || shouldTestLocal;

  let contextManager: AsyncHooksContextManager;
  beforeEach(() => {
    contextManager = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    context.disable();
  });

  before(function () {
    // needs to be "function" to have MochaContext "this" context
    if (!shouldTest) {
      // this.skip() workaround
      // https://github.com/mochajs/mocha/issues/2683#issuecomment-375629901
      this.test!.parent!.pending = true;
      this.skip();
    }

    if (shouldTestLocal) {
      testUtils.startDocker('redis');
    }

    redis = require('redis');
    provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
    instrumentation.setTracerProvider(provider);
    instrumentation.enable();
  });

  after(() => {
    if (shouldTestLocal) {
      testUtils.cleanUpDocker('redis');
    }
  });

  describe('#createClient()', () => {
    it('should propagate the current span to event handlers', done => {
      const span = tracer.startSpan('test span');
      let client: redisTypes.RedisClient;
      const readyHandler = () => {
        assert.strictEqual(getSpan(context.active()), span);
        client.quit(done);
      };
      const errorHandler = (err: Error) => {
        assert.ifError(err);
        client.quit(done);
      };

      context.with(setSpan(context.active(), span), () => {
        client = redis.createClient(URL);
        client.on('ready', readyHandler);
        client.on('error', errorHandler);
      });
    });
  });

  describe('#send_internal_message()', () => {
    let client: redisTypes.RedisClient;

    const REDIS_OPERATIONS: Array<{
      description: string;
      command: string;
      method: (cb: redisTypes.Callback<unknown>) => unknown;
    }> = [
      {
        description: 'insert',
        command: 'hset',
        method: (cb: redisTypes.Callback<number>) =>
          client.hset('hash', 'random', 'random', cb),
      },
      {
        description: 'get',
        command: 'get',
        method: (cb: redisTypes.Callback<string | null>) =>
          client.get('test', cb),
      },
      {
        description: 'delete',
        command: 'del',
        method: (cb: redisTypes.Callback<number>) => client.del('test', cb),
      },
    ];

    before(done => {
      client = redis.createClient(URL);
      client.on('error', err => {
        done(err);
      });
      client.on('ready', done);
    });

    beforeEach(done => {
      client.set('test', 'data', () => {
        memoryExporter.reset();
        done();
      });
    });

    after(done => {
      client.quit(done);
    });

    afterEach(done => {
      client.del('hash', () => {
        memoryExporter.reset();
        done();
      });
    });

    describe('Instrumenting query operations', () => {
      REDIS_OPERATIONS.forEach(operation => {
        it(`should create a child span for ${operation.description}`, done => {
          const attributes = {
            ...DEFAULT_ATTRIBUTES,
            [SemanticAttributes.DB_STATEMENT]: operation.command,
          };
          const span = tracer.startSpan('test span');
          context.with(setSpan(context.active(), span), () => {
            operation.method((err, _result) => {
              assert.ifError(err);
              assert.strictEqual(memoryExporter.getFinishedSpans().length, 1);
              span.end();
              const endedSpans = memoryExporter.getFinishedSpans();
              assert.strictEqual(endedSpans.length, 2);
              assert.strictEqual(
                endedSpans[0].name,
                `redis-${operation.command}`
              );
              testUtils.assertSpan(
                endedSpans[0],
                SpanKind.CLIENT,
                attributes,
                [],
                unsetStatus
              );
              testUtils.assertPropagation(endedSpans[0], span);
              done();
            });
          });
        });
      });
    });

    describe('Removing instrumentation', () => {
      before(() => {
        instrumentation.disable();
      });

      REDIS_OPERATIONS.forEach(operation => {
        it(`should not create a child span for ${operation.description}`, done => {
          const span = tracer.startSpan('test span');
          context.with(setSpan(context.active(), span), () => {
            operation.method((err, _) => {
              assert.ifError(err);
              assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
              span.end();
              const endedSpans = memoryExporter.getFinishedSpans();
              assert.strictEqual(endedSpans.length, 1);
              assert.strictEqual(endedSpans[0], span);
              done();
            });
          });
        });
      });
    });
  });
});
