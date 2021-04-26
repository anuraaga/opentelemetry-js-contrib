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

// We access through node_modules to allow it to be patched.
/* eslint-disable node/no-extraneous-require */

import * as path from 'path';

import { AwsLambdaInstrumentation } from '../../src';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  ReadableSpan,
} from '@opentelemetry/tracing';
import { NodeTracerProvider } from '@opentelemetry/node';
import { Context } from 'aws-lambda';
import * as assert from 'assert';
import {
  context,
  setSpanContext,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  TextMapPropagator,
} from '@opentelemetry/api';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { HttpTraceContext } from '@opentelemetry/core';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';

const memoryExporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider();
provider.addSpanProcessor(new BatchSpanProcessor(memoryExporter));
provider.register();

const assertSpanSuccess = (span: ReadableSpan) => {
  assert.strictEqual(span.kind, SpanKind.SERVER);
  assert.strictEqual(span.name, 'my_function');
  assert.strictEqual(
    span.attributes[SemanticAttributes.FAAS_EXECUTION],
    'aws_request_id'
  );
  assert.strictEqual(span.attributes['faas.id'], 'my_arn');
  assert.strictEqual(span.status.code, SpanStatusCode.UNSET);
  assert.strictEqual(span.status.message, undefined);
};

const assertSpanFailure = (span: ReadableSpan) => {
  assert.strictEqual(span.kind, SpanKind.SERVER);
  assert.strictEqual(span.name, 'my_function');
  assert.strictEqual(
    span.attributes[SemanticAttributes.FAAS_EXECUTION],
    'aws_request_id'
  );
  assert.strictEqual(span.attributes['faas.id'], 'my_arn');
  assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
  assert.strictEqual(span.status.message, 'handler error');
  assert.strictEqual(span.events.length, 1);
  assert.strictEqual(
    span.events[0].attributes![SemanticAttributes.EXCEPTION_MESSAGE],
    'handler error'
  );
};

const serializeSpanContext = (
  spanContext: SpanContext,
  propagator: TextMapPropagator
): string => {
  let serialized = '';
  propagator.inject(
    setSpanContext(context.active(), spanContext),
    {},
    {
      set(carrier: any, key: string, value: string) {
        serialized = value;
      },
    }
  );
  return serialized;
};

describe('lambda handler', () => {
  let instrumentation: AwsLambdaInstrumentation;

  let oldEnv: NodeJS.ProcessEnv;

  const ctx = {
    functionName: 'my_function',
    invokedFunctionArn: 'my_arn',
    awsRequestId: 'aws_request_id',
  } as Context;

  const initializeHandler = (handler: string) => {
    process.env._HANDLER = handler;

    instrumentation = new AwsLambdaInstrumentation();
    instrumentation.setTracerProvider(provider);
  };

  const lambdaRequire = (module: string) =>
    require(path.resolve(__dirname, '..', module));

  const sampledAwsSpanContext: SpanContext = {
    traceId: '8a3c60f7d188f8fa79d48a391a778fa6',
    spanId: '0000000000000456',
    traceFlags: 1,
    isRemote: true,
  };
  const sampledAwsHeader = serializeSpanContext(
    sampledAwsSpanContext,
    new AWSXRayPropagator()
  );

  const sampledHttpSpanContext: SpanContext = {
    traceId: '8a3c60f7d188f8fa79d48a391a778fa7',
    spanId: '0000000000000457',
    traceFlags: 1,
    isRemote: true,
  };
  const sampledHttpHeader = serializeSpanContext(
    sampledHttpSpanContext,
    new HttpTraceContext()
  );

  const unsampledAwsSpanContext: SpanContext = {
    traceId: '8a3c60f7d188f8fa79d48a391a778fa8',
    spanId: '0000000000000458',
    traceFlags: 0,
    isRemote: true,
  };
  const unsampledAwsHeader = serializeSpanContext(
    unsampledAwsSpanContext,
    new AWSXRayPropagator()
  );

  const unsampledHttpSpanContext: SpanContext = {
    traceId: '8a3c60f7d188f8fa79d48a391a778fa9',
    spanId: '0000000000000459',
    traceFlags: 0,
    isRemote: true,
  };
  const unsampledHttpHeader = serializeSpanContext(
    unsampledHttpSpanContext,
    new HttpTraceContext()
  );

  beforeEach(() => {
    oldEnv = { ...process.env };
    process.env.LAMBDA_TASK_ROOT = path.resolve(__dirname, '..');
  });

  afterEach(() => {
    process.env = oldEnv;
    instrumentation.disable();

    memoryExporter.reset();
  });

  describe('async success handler', () => {
    it('should export a valid span', async () => {
      initializeHandler('lambda-test/async.handler');

      const result = await lambdaRequire('lambda-test/async').handler(
        'arg',
        ctx
      );
      assert.strictEqual(result, 'ok');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanSuccess(span);
      assert.strictEqual(span.parentSpanId, undefined);
    });

    it('should record error', async () => {
      initializeHandler('lambda-test/async.error');

      let err: Error;
      try {
        await lambdaRequire('lambda-test/async').error('arg', ctx);
      } catch (e) {
        err = e;
      }
      assert.strictEqual(err!.message, 'handler error');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanFailure(span);
      assert.strictEqual(span.parentSpanId, undefined);
    });

    it('should record string error', async () => {
      initializeHandler('lambda-test/async.stringerror');

      let err: string;
      try {
        await lambdaRequire('lambda-test/async').stringerror('arg', ctx);
      } catch (e) {
        err = e;
      }
      assert.strictEqual(err!, 'handler error');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assertSpanFailure(span);
      assert.strictEqual(span.parentSpanId, undefined);
    });

    it('context should have parent trace', async () => {
      initializeHandler('lambda-test/async.context');

      const result = await lambdaRequire('lambda-test/async').context(
        'arg',
        ctx
      );
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(span.spanContext.traceId, result);
    });

    it('context should have parent trace', async () => {
      initializeHandler('lambda-test/async.context');

      const result = await lambdaRequire('lambda-test/async').context(
        'arg',
        ctx
      );
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(span.spanContext.traceId, result);
    });
  });

  describe('sync success handler', () => {
    it('should export a valid span', async () => {
      initializeHandler('lambda-test/sync.handler');

      const result = await new Promise((resolve, reject) => {
        lambdaRequire('lambda-test/sync').handler(
          'arg',
          ctx,
          (err: Error, res: any) => {
            if (err) {
              reject(err);
            } else {
              resolve(res);
            }
          }
        );
      });
      assert.strictEqual(result, 'ok');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanSuccess(span);
      assert.strictEqual(span.parentSpanId, undefined);
    });

    it('should record error', async () => {
      initializeHandler('lambda-test/sync.error');

      let err: Error;
      try {
        lambdaRequire('lambda-test/sync').error(
          'arg',
          ctx,
          (err: Error, res: any) => {}
        );
      } catch (e) {
        err = e;
      }
      assert.strictEqual(err!.message, 'handler error');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanFailure(span);
      assert.strictEqual(span.parentSpanId, undefined);
    });

    it('should record error in callback', async () => {
      initializeHandler('lambda-test/sync.callbackerror');

      let err: Error;
      try {
        await new Promise((resolve, reject) => {
          lambdaRequire('lambda-test/sync').callbackerror(
            'arg',
            ctx,
            (err: Error, res: any) => {
              if (err) {
                reject(err);
              } else {
                resolve(res);
              }
            }
          );
        });
      } catch (e) {
        err = e;
      }
      assert.strictEqual(err!.message, 'handler error');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanFailure(span);
      assert.strictEqual(span.parentSpanId, undefined);
    });

    it('should record string error', async () => {
      initializeHandler('lambda-test/sync.stringerror');

      let err: string;
      try {
        lambdaRequire('lambda-test/sync').stringerror(
          'arg',
          ctx,
          (err: Error, res: any) => {}
        );
      } catch (e) {
        err = e;
      }
      assert.strictEqual(err!, 'handler error');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanFailure(span);
      assert.strictEqual(span.parentSpanId, undefined);
    });

    it('context should have parent trace', async () => {
      initializeHandler('lambda-test/sync.context');

      const result = await new Promise((resolve, reject) => {
        lambdaRequire('lambda-test/sync').context(
          'arg',
          ctx,
          (err: Error, res: any) => {
            if (err) {
              reject(err);
            } else {
              resolve(res);
            }
          }
        );
      });
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(span.spanContext.traceId, result);
    });

    it('context should have parent trace', async () => {
      initializeHandler('lambda-test/sync.context');

      const result = await new Promise((resolve, reject) => {
        lambdaRequire('lambda-test/sync').context(
          'arg',
          ctx,
          (err: Error, res: any) => {
            if (err) {
              reject(err);
            } else {
              resolve(res);
            }
          }
        );
      });
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(span.spanContext.traceId, result);
    });
  });

  it('should record string error in callback', async () => {
    initializeHandler('lambda-test/sync.callbackstringerror');

    let err: string;
    try {
      await new Promise((resolve, reject) => {
        lambdaRequire('lambda-test/sync').callbackstringerror(
          'arg',
          ctx,
          (err: Error, res: any) => {
            if (err) {
              reject(err);
            } else {
              resolve(res);
            }
          }
        );
      });
    } catch (e) {
      err = e;
    }
    assert.strictEqual(err!, 'handler error');
    const spans = memoryExporter.getFinishedSpans();
    const [span] = spans;
    assert.strictEqual(spans.length, 1);
    assertSpanFailure(span);
    assert.strictEqual(span.parentSpanId, undefined);
  });

  describe('with remote parent', () => {
    it('uses lambda context if sampled and no http context', async () => {
      process.env['_X_AMZN_TRACE_ID'] = sampledAwsHeader;
      initializeHandler('lambda-test/async.handler');

      const result = await lambdaRequire('lambda-test/async').handler(
        'arg',
        ctx
      );
      assert.strictEqual(result, 'ok');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanSuccess(span);
      assert.strictEqual(
        span.spanContext.traceId,
        sampledAwsSpanContext.traceId
      );
      assert.strictEqual(span.parentSpanId, sampledAwsSpanContext.spanId);
    });

    it('uses lambda context if unsampled and no http context', async () => {
      process.env['_X_AMZN_TRACE_ID'] = unsampledAwsHeader;
      initializeHandler('lambda-test/async.handler');

      const result = await lambdaRequire('lambda-test/async').handler(
        'arg',
        ctx
      );
      assert.strictEqual(result, 'ok');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanSuccess(span);
      assert.strictEqual(
        span.spanContext.traceId,
        unsampledAwsSpanContext.traceId
      );
      assert.strictEqual(span.parentSpanId, unsampledAwsSpanContext.spanId);
    });

    it('uses lambda context if sampled and http context present', async () => {
      process.env['_X_AMZN_TRACE_ID'] = sampledAwsHeader;
      initializeHandler('lambda-test/async.handler');

      const proxyEvent = {
        headers: {
          traceparent: sampledHttpHeader,
        },
      };

      const result = await lambdaRequire('lambda-test/async').handler(
        proxyEvent,
        ctx
      );
      assert.strictEqual(result, 'ok');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanSuccess(span);
      assert.strictEqual(
        span.spanContext.traceId,
        sampledAwsSpanContext.traceId
      );
      assert.strictEqual(span.parentSpanId, sampledAwsSpanContext.spanId);
    });

    it('uses http context if sampled and lambda context unsampled', async () => {
      process.env['_X_AMZN_TRACE_ID'] = unsampledAwsHeader;
      initializeHandler('lambda-test/async.handler');

      const proxyEvent = {
        headers: {
          traceparent: sampledHttpHeader,
        },
      };

      const result = await lambdaRequire('lambda-test/async').handler(
        proxyEvent,
        ctx
      );
      assert.strictEqual(result, 'ok');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanSuccess(span);
      assert.strictEqual(
        span.spanContext.traceId,
        sampledHttpSpanContext.traceId
      );
      assert.strictEqual(span.parentSpanId, sampledHttpSpanContext.spanId);
    });

    it('uses http context if unsampled and lambda context unsampled', async () => {
      process.env['_X_AMZN_TRACE_ID'] = unsampledAwsHeader;
      initializeHandler('lambda-test/async.handler');

      const proxyEvent = {
        headers: {
          traceparent: unsampledHttpHeader,
        },
      };

      const result = await lambdaRequire('lambda-test/async').handler(
        proxyEvent,
        ctx
      );
      assert.strictEqual(result, 'ok');
      const spans = memoryExporter.getFinishedSpans();
      const [span] = spans;
      assert.strictEqual(spans.length, 1);
      assertSpanSuccess(span);
      assert.strictEqual(
        span.spanContext.traceId,
        unsampledHttpSpanContext.traceId
      );
      assert.strictEqual(span.parentSpanId, unsampledHttpSpanContext.spanId);
    });
  });
});
