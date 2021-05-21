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
exports.AwsLambdaInstrumentation = exports.traceContextEnvironmentKey = void 0;
const path = require("path");
const instrumentation_1 = require("@opentelemetry/instrumentation");
const propagator_aws_xray_1 = require("@opentelemetry/propagator-aws-xray");
const api_1 = require("@opentelemetry/api");
const resources_1 = require("@opentelemetry/resources");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const version_1 = require("./version");
const tracing_1 = require("@opentelemetry/tracing");
const awsPropagator = new propagator_aws_xray_1.AWSXRayPropagator();
const headerGetter = {
    keys(carrier) {
        return Object.keys(carrier);
    },
    get(carrier, key) {
        return carrier[key];
    },
};
exports.traceContextEnvironmentKey = '_X_AMZN_TRACE_ID';
class AwsLambdaInstrumentation extends instrumentation_1.InstrumentationBase {
    constructor() {
        super('@opentelemetry/instrumentation-aws-lambda', version_1.VERSION);
    }
    init() {
        const taskRoot = process.env.LAMBDA_TASK_ROOT;
        const handlerDef = process.env._HANDLER;
        // _HANDLER and LAMBDA_TASK_ROOT are always defined in Lambda but guard bail out if in the future this changes.
        if (!taskRoot || !handlerDef) {
            return [];
        }
        const handler = path.basename(handlerDef);
        const moduleRoot = handlerDef.substr(0, handlerDef.length - handler.length);
        const [module, functionName] = handler.split('.', 2);
        // Lambda loads user function using an absolute path.
        let filename = path.resolve(taskRoot, moduleRoot, module);
        if (!filename.endsWith('.js')) {
            // Patching infrastructure currently requires a filename when requiring with an absolute path.
            filename += '.js';
        }
        return [
            new instrumentation_1.InstrumentationNodeModuleDefinition(
            // NB: The patching infrastructure seems to match names backwards, this must be the filename, while
            // InstrumentationNodeModuleFile must be the module name.
            filename, ['*'], undefined, undefined, [
                new instrumentation_1.InstrumentationNodeModuleFile(module, ['*'], (moduleExports) => {
                    api_1.diag.debug('Applying patch for lambda handler');
                    if (instrumentation_1.isWrapped(moduleExports[functionName])) {
                        this._unwrap(moduleExports, functionName);
                    }
                    this._wrap(moduleExports, functionName, this._getHandler());
                    return moduleExports;
                }, (moduleExports) => {
                    if (moduleExports == undefined)
                        return;
                    api_1.diag.debug('Removing patch for lambda handler');
                    this._unwrap(moduleExports, functionName);
                }),
            ]),
        ];
    }
    _getHandler() {
        return (original) => {
            return this._getPatchHandler(original);
        };
    }
    _getPatchHandler(original) {
        api_1.diag.debug('patch handler function');
        const plugin = this;
        return function patchedHandler(
        // The event can be a user type, it truly is any.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        event, context, callback) {
            const httpHeaders = typeof event.headers === 'object' ? event.headers : {};
            const parent = AwsLambdaInstrumentation._determineParent(httpHeaders);
            const name = context.functionName;
            const span = plugin.tracer.startSpan(name, {
                kind: api_1.SpanKind.SERVER,
                attributes: {
                    [semantic_conventions_1.SemanticAttributes.FAAS_EXECUTION]: context.awsRequestId,
                    'faas.id': context.invokedFunctionArn,
                    [resources_1.CLOUD_RESOURCE.ACCOUNT_ID]: AwsLambdaInstrumentation._extractAccountId(context.invokedFunctionArn),
                },
            }, parent);
            return api_1.context.with(api_1.setSpan(api_1.context.active(), span), () => {
                // Lambda seems to pass a callback even if handler is of Promise form, so we wrap all the time before calling
                // the handler and see if the result is a Promise or not. In such a case, the callback is usually ignored. If
                // the handler happened to both call the callback and complete a returned Promise, whichever happens first will
                // win and the latter will be ignored.
                const wrappedCallback = plugin._wrapCallback(callback, span);
                const maybePromise = instrumentation_1.safeExecuteInTheMiddle(() => original.apply(this, [event, context, wrappedCallback]), error => {
                    if (error != null) {
                        // Exception thrown synchronously before resolving callback / promise.
                        plugin._endSpan(span, error, () => { });
                    }
                });
                if (typeof (maybePromise === null || maybePromise === void 0 ? void 0 : maybePromise.then) === 'function') {
                    return maybePromise.then(value => new Promise(resolve => plugin._endSpan(span, undefined, () => resolve(value))), (err) => new Promise((resolve, reject) => plugin._endSpan(span, err, () => reject(err))));
                }
                return maybePromise;
            });
        };
    }
    setTracerProvider(tracerProvider) {
        super.setTracerProvider(tracerProvider);
        this._tracerProvider = tracerProvider;
    }
    _wrapCallback(original, span) {
        const plugin = this;
        return function wrappedCallback(err, res) {
            api_1.diag.debug('executing wrapped lookup callback function');
            plugin._endSpan(span, err, () => {
                api_1.diag.debug('executing original lookup callback function');
                return original.apply(this, [err, res]);
            });
        };
    }
    _endSpan(span, err, callback) {
        if (err) {
            span.recordException(err);
        }
        let errMessage;
        if (typeof err === 'string') {
            errMessage = err;
        }
        else if (err) {
            errMessage = err.message;
        }
        if (errMessage) {
            span.setStatus({
                code: api_1.SpanStatusCode.ERROR,
                message: errMessage,
            });
        }
        span.end();
        if (this._tracerProvider instanceof tracing_1.BasicTracerProvider) {
            this._tracerProvider
                .getActiveSpanProcessor()
                .forceFlush()
                .then(() => callback(), () => callback());
        }
        else {
            callback();
        }
    }
    static _extractAccountId(arn) {
        const parts = arn.split(':');
        if (parts.length >= 5) {
            return parts[4];
        }
        return undefined;
    }
    static _determineParent(httpHeaders) {
        let parent = undefined;
        const lambdaTraceHeader = process.env[exports.traceContextEnvironmentKey];
        if (lambdaTraceHeader) {
            parent = awsPropagator.extract(api_1.context.active(), { [propagator_aws_xray_1.AWSXRAY_TRACE_ID_HEADER]: lambdaTraceHeader }, headerGetter);
        }
        if (parent) {
            const spanContext = api_1.getSpanContext(parent);
            if (spanContext &&
                (spanContext.traceFlags & api_1.TraceFlags.SAMPLED) === api_1.TraceFlags.SAMPLED) {
                // Trace header provided by Lambda only sampled if a sampled context was propagated from
                // an upstream cloud service such as S3, or the user is using X-Ray. In these cases, we
                // need to use it as the parent.
                return parent;
            }
        }
        // There was not a sampled trace header from Lambda so try from HTTP headers.
        const httpContext = api_1.propagation.extract(api_1.context.active(), httpHeaders, headerGetter);
        if (api_1.getSpanContext(httpContext)) {
            return httpContext;
        }
        if (!parent) {
            // No context in Lambda environment or HTTP headers.
            return api_1.context.active();
        }
        return parent;
    }
}
exports.AwsLambdaInstrumentation = AwsLambdaInstrumentation;
//# sourceMappingURL=aws-lambda.js.map