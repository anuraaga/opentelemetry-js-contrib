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
exports.AWSXRayIdGenerator = void 0;
const xray_id_generation_1 = require("../../internal/xray-id-generation");
/**
 * IdGenerator that generates trace IDs conforming to AWS X-Ray format.
 * https://docs.aws.amazon.com/xray/latest/devguide/xray-api-sendingdata.html#xray-api-traceids
 */
class AWSXRayIdGenerator {
    /**
     * Returns a random 16-byte trace ID formatted/encoded as a 32 lowercase hex
     * characters corresponding to 128 bits. The first 4 bytes correspond to the current
     * time, in seconds, as per X-Ray trace ID format.
     */
    generateTraceId() {
        return xray_id_generation_1.generateTraceId(generateRandomBytes);
    }
    /**
     * Returns a random 8-byte span ID formatted/encoded as a 16 lowercase hex
     * characters corresponding to 64 bits.
     */
    generateSpanId() {
        return xray_id_generation_1.generateSpanId(generateRandomBytes);
    }
}
exports.AWSXRayIdGenerator = AWSXRayIdGenerator;
const SHARED_BUFFER = Buffer.allocUnsafe(xray_id_generation_1.TRACE_ID_BYTES);
function generateRandomBytes(bytes) {
    for (let i = 0; i < bytes / 4; i++) {
        // unsigned right shift drops decimal part of the number
        // it is required because if a number between 2**32 and 2**32 - 1 is generated, an out of range error is thrown by writeUInt32BE
        SHARED_BUFFER.writeUInt32BE((Math.random() * 2 ** 32) >>> 0, i * 4);
    }
    return SHARED_BUFFER.toString('hex', 0, bytes);
}
//# sourceMappingURL=AWSXRayIdGenerator.js.map