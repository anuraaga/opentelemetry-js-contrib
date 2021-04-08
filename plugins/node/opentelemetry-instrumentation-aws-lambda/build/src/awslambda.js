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
exports.AwsLambdaInstrumentation = void 0;
const path = require("path");
const instrumentation_1 = require("@opentelemetry/instrumentation");
const api_1 = require("@opentelemetry/api");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const version_1 = require("./version");
class AwsLambdaInstrumentation extends instrumentation_1.InstrumentationBase {
    constructor() {
        super('@opentelemetry/instrumentation-awslambda', version_1.VERSION);
    }
    init() {
        // _HANDLER and LAMBDA_TASK_ROOT are always defined in Lambda.
        const taskRoot = process.env.LAMBDA_TASK_ROOT;
        const handlerDef = process.env._HANDLER;
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
                    api_1.diag.debug('Applying patch for lambdatest handler');
                    if (instrumentation_1.isWrapped(moduleExports[functionName])) {
                        this._unwrap(moduleExports, functionName);
                    }
                    this._wrap(moduleExports, functionName, this._getHandler());
                    return moduleExports;
                }, (moduleExports) => {
                    if (moduleExports == undefined)
                        return;
                    api_1.diag.debug('Removing patch for lambdatest handler');
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
        return function patchedHandler(event, context, callback) {
            const name = context.functionName;
            const span = plugin.tracer.startSpan(name, {
                kind: api_1.SpanKind.SERVER,
                attributes: {
                    [semantic_conventions_1.FaasAttribute.FAAS_EXECUTION]: context.awsRequestId,
                    [semantic_conventions_1.FaasAttribute.FAAS_ID]: context.invokedFunctionArn,
                },
            });
            // Lambda seems to pass a callback even if handler is of Promise form, so we wrap all the time before calling
            // the handler and see if the result is a Promise or not. In such a case, the callback is usually ignored.
            const wrappedCallback = plugin._wrapCallback(callback, span);
            const maybePromise = instrumentation_1.safeExecuteInTheMiddle(() => original.apply(this, [event, context, wrappedCallback]), error => {
                if (error != null) {
                    span.setStatus({
                        code: api_1.SpanStatusCode.ERROR,
                        message: typeof error === 'string' ? error : error.message,
                    });
                    span.end();
                }
            });
            if (typeof maybePromise !== 'undefined' &&
                typeof maybePromise.then === 'function') {
                maybePromise.then(() => span.end(), (err) => {
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
                });
            }
            return maybePromise;
        };
    }
    _wrapCallback(original, span) {
        return function wrappedCallback(err, res) {
            api_1.diag.debug('executing wrapped lookup callback function');
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
            api_1.diag.debug('executing original lookup callback function');
            return original.apply(this, [err, res]);
        };
    }
}
exports.AwsLambdaInstrumentation = AwsLambdaInstrumentation;
//# sourceMappingURL=awslambda.js.map