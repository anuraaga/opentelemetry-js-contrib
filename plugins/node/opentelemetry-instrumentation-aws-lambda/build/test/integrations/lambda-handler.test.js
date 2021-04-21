"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
// We access through node_modules to allow it to be patched.
/* eslint-disable node/no-extraneous-require */
const path = require("path");
const src_1 = require("../../src");
const tracing_1 = require("@opentelemetry/tracing");
const node_1 = require("@opentelemetry/node");
const assert = require("assert");
const api_1 = require("@opentelemetry/api");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const propagator_aws_xray_1 = require("@opentelemetry/propagator-aws-xray");
const core_1 = require("@opentelemetry/core");
const memoryExporter = new tracing_1.InMemorySpanExporter();
const provider = new node_1.NodeTracerProvider();
provider.addSpanProcessor(new tracing_1.BatchSpanProcessor(memoryExporter));
provider.register();
const assertSpanSuccess = (span) => {
    assert.strictEqual(span.kind, api_1.SpanKind.SERVER);
    assert.strictEqual(span.name, 'my_function');
    assert.strictEqual(span.attributes[semantic_conventions_1.FaasAttribute.FAAS_EXECUTION], 'aws_request_id');
    assert.strictEqual(span.attributes[semantic_conventions_1.FaasAttribute.FAAS_ID], 'my_arn');
    assert.strictEqual(span.status.code, api_1.SpanStatusCode.UNSET);
    assert.strictEqual(span.status.message, undefined);
};
const assertSpanFailure = (span) => {
    assert.strictEqual(span.kind, api_1.SpanKind.SERVER);
    assert.strictEqual(span.name, 'my_function');
    assert.strictEqual(span.attributes[semantic_conventions_1.FaasAttribute.FAAS_EXECUTION], 'aws_request_id');
    assert.strictEqual(span.attributes[semantic_conventions_1.FaasAttribute.FAAS_ID], 'my_arn');
    assert.strictEqual(span.status.code, api_1.SpanStatusCode.ERROR);
    assert.strictEqual(span.status.message, 'handler error');
    assert.strictEqual(span.events.length, 1);
    assert.strictEqual(span.events[0].attributes[semantic_conventions_1.ExceptionAttribute.MESSAGE], 'handler error');
};
const serializeSpanContext = (spanContext, propagator) => {
    let serialized = '';
    propagator.inject(api_1.setSpanContext(api_1.context.active(), spanContext), {}, {
        set(carrier, key, value) {
            serialized = value;
        },
    });
    return serialized;
};
describe('lambda handler', () => {
    let instrumentation;
    let oldEnv;
    const ctx = {
        functionName: 'my_function',
        invokedFunctionArn: 'my_arn',
        awsRequestId: 'aws_request_id',
    };
    const initializeHandler = (handler) => {
        process.env._HANDLER = handler;
        instrumentation = new src_1.AwsLambdaInstrumentation();
        instrumentation.setTracerProvider(provider);
    };
    const lambdaRequire = (module) => require(path.resolve(__dirname, '..', module));
    const sampledAwsSpanContext = {
        traceId: '8a3c60f7d188f8fa79d48a391a778fa6',
        spanId: '0000000000000456',
        traceFlags: 1,
        isRemote: true,
    };
    const sampledAwsHeader = serializeSpanContext(sampledAwsSpanContext, new propagator_aws_xray_1.AWSXRayPropagator());
    const sampledHttpSpanContext = {
        traceId: '8a3c60f7d188f8fa79d48a391a778fa7',
        spanId: '0000000000000457',
        traceFlags: 1,
        isRemote: true,
    };
    const sampledHttpHeader = serializeSpanContext(sampledHttpSpanContext, new core_1.HttpTraceContext());
    const unsampledAwsSpanContext = {
        traceId: '8a3c60f7d188f8fa79d48a391a778fa8',
        spanId: '0000000000000458',
        traceFlags: 0,
        isRemote: true,
    };
    const unsampledAwsHeader = serializeSpanContext(unsampledAwsSpanContext, new propagator_aws_xray_1.AWSXRayPropagator());
    const unsampledHttpSpanContext = {
        traceId: '8a3c60f7d188f8fa79d48a391a778fa9',
        spanId: '0000000000000459',
        traceFlags: 0,
        isRemote: true,
    };
    const unsampledHttpHeader = serializeSpanContext(unsampledHttpSpanContext, new core_1.HttpTraceContext());
    beforeEach(() => {
        oldEnv = Object.assign({}, process.env);
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
            const result = await lambdaRequire('lambda-test/async').handler('arg', ctx);
            assert.strictEqual(result, 'ok');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanSuccess(span);
            assert.strictEqual(span.parentSpanId, undefined);
        });
        it('should record error', async () => {
            initializeHandler('lambda-test/async.error');
            let err;
            try {
                await lambdaRequire('lambda-test/async').error('arg', ctx);
            }
            catch (e) {
                err = e;
            }
            assert.strictEqual(err.message, 'handler error');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanFailure(span);
            assert.strictEqual(span.parentSpanId, undefined);
        });
        it('should record string error', async () => {
            initializeHandler('lambda-test/async.stringerror');
            let err;
            try {
                await lambdaRequire('lambda-test/async').stringerror('arg', ctx);
            }
            catch (e) {
                err = e;
            }
            assert.strictEqual(err, 'handler error');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assertSpanFailure(span);
            assert.strictEqual(span.parentSpanId, undefined);
        });
        it('context should have parent trace', async () => {
            initializeHandler('lambda-test/async.context');
            const result = await lambdaRequire('lambda-test/async').context('arg', ctx);
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(span.spanContext.traceId, result);
        });
    });
    describe('sync success handler', () => {
        it('should export a valid span', async () => {
            initializeHandler('lambda-test/sync.handler');
            const result = await new Promise((resolve, reject) => {
                lambdaRequire('lambda-test/sync').handler('arg', ctx, (err, res) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(res);
                    }
                });
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
            let err;
            try {
                lambdaRequire('lambda-test/sync').error('arg', ctx, (err, res) => { });
            }
            catch (e) {
                err = e;
            }
            assert.strictEqual(err.message, 'handler error');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanFailure(span);
            assert.strictEqual(span.parentSpanId, undefined);
        });
        it('should record error in callback', async () => {
            initializeHandler('lambda-test/sync.callbackerror');
            let err;
            try {
                await new Promise((resolve, reject) => {
                    lambdaRequire('lambda-test/sync').callbackerror('arg', ctx, (err, res) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            resolve(res);
                        }
                    });
                });
            }
            catch (e) {
                err = e;
            }
            assert.strictEqual(err.message, 'handler error');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanFailure(span);
            assert.strictEqual(span.parentSpanId, undefined);
        });
        it('should record string error', async () => {
            initializeHandler('lambda-test/sync.stringerror');
            let err;
            try {
                lambdaRequire('lambda-test/sync').stringerror('arg', ctx, (err, res) => { });
            }
            catch (e) {
                err = e;
            }
            assert.strictEqual(err, 'handler error');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanFailure(span);
            assert.strictEqual(span.parentSpanId, undefined);
        });
        it('context should have parent trace', async () => {
            initializeHandler('lambda-test/sync.context');
            const result = await new Promise((resolve, reject) => {
                lambdaRequire('lambda-test/sync').context('arg', ctx, (err, res) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(res);
                    }
                });
            });
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(span.spanContext.traceId, result);
        });
    });
    it('should record string error in callback', async () => {
        initializeHandler('lambda-test/sync.callbackstringerror');
        let err;
        try {
            await new Promise((resolve, reject) => {
                lambdaRequire('lambda-test/sync').callbackstringerror('arg', ctx, (err, res) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(res);
                    }
                });
            });
        }
        catch (e) {
            err = e;
        }
        assert.strictEqual(err, 'handler error');
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
            const result = await lambdaRequire('lambda-test/async').handler('arg', ctx);
            assert.strictEqual(result, 'ok');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanSuccess(span);
            assert.strictEqual(span.spanContext.traceId, sampledAwsSpanContext.traceId);
            assert.strictEqual(span.parentSpanId, sampledAwsSpanContext.spanId);
        });
        it('uses lambda context if unsampled and no http context', async () => {
            process.env['_X_AMZN_TRACE_ID'] = unsampledAwsHeader;
            initializeHandler('lambda-test/async.handler');
            const result = await lambdaRequire('lambda-test/async').handler('arg', ctx);
            assert.strictEqual(result, 'ok');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanSuccess(span);
            assert.strictEqual(span.spanContext.traceId, unsampledAwsSpanContext.traceId);
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
            const result = await lambdaRequire('lambda-test/async').handler(proxyEvent, ctx);
            assert.strictEqual(result, 'ok');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanSuccess(span);
            assert.strictEqual(span.spanContext.traceId, sampledAwsSpanContext.traceId);
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
            const result = await lambdaRequire('lambda-test/async').handler(proxyEvent, ctx);
            assert.strictEqual(result, 'ok');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanSuccess(span);
            assert.strictEqual(span.spanContext.traceId, sampledHttpSpanContext.traceId);
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
            const result = await lambdaRequire('lambda-test/async').handler(proxyEvent, ctx);
            assert.strictEqual(result, 'ok');
            const spans = memoryExporter.getFinishedSpans();
            const [span] = spans;
            assert.strictEqual(spans.length, 1);
            assertSpanSuccess(span);
            assert.strictEqual(span.spanContext.traceId, unsampledHttpSpanContext.traceId);
            assert.strictEqual(span.parentSpanId, unsampledHttpSpanContext.spanId);
        });
    });
});
//# sourceMappingURL=lambda-handler.test.js.map