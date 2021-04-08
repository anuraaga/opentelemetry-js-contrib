import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
export declare class AwsLambdaInstrumentation extends InstrumentationBase {
    constructor();
    init(): InstrumentationNodeModuleDefinition<unknown>[];
    private _getHandler;
    private _getPatchHandler;
    private _wrapCallback;
}
//# sourceMappingURL=awslambda.d.ts.map