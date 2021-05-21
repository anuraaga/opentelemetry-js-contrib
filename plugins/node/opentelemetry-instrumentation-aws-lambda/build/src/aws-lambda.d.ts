import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { TracerProvider } from '@opentelemetry/api';
export declare const traceContextEnvironmentKey = "_X_AMZN_TRACE_ID";
export declare class AwsLambdaInstrumentation extends InstrumentationBase {
    private _tracerProvider;
    constructor();
    init(): InstrumentationNodeModuleDefinition<unknown>[];
    private _getHandler;
    private _getPatchHandler;
    setTracerProvider(tracerProvider: TracerProvider): void;
    private _wrapCallback;
    private _endSpan;
    private static _extractAccountId;
    private static _determineParent;
}
//# sourceMappingURL=aws-lambda.d.ts.map