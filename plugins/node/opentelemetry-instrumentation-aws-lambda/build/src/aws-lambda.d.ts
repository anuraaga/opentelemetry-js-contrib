import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { TracerProvider } from '@opentelemetry/api';
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
}
//# sourceMappingURL=aws-lambda.d.ts.map