/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Attributes, Context, Link, SpanKind, diag } from '@opentelemetry/api';
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  Sampler,
  SamplingResult,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';

import { PolicyImplementer } from './implementer';
import {
  MatchPredicate,
  Policy,
  PolicyApplyStatus,
  TargetType,
  TraceMatcher,
  TraceSamplingConfig,
} from './model';

class UnsupportedPolicyError extends Error {}

/** A matcher compiled for evaluation at sampling time. */
class CompiledMatcher {
  private _key = '';
  private _isTraceId = false;
  private _predicate: MatchPredicate;
  private _negate: boolean;
  private _caseInsensitive: boolean;
  private _pattern: RegExp | undefined;
  private _text = '';

  constructor(matcher: TraceMatcher) {
    const field = matcher.field;
    if (field.kind === 'traceField') {
      if (field.name !== 'trace_id') {
        throw new UnsupportedPolicyError(
          `trace_field '${field.name}' is not supported, only 'trace_id'`
        );
      }
      this._isTraceId = true;
    } else if (field.kind === 'spanAttribute') {
      if (field.path.length !== 1) {
        throw new UnsupportedPolicyError(
          'nested span_attribute paths are not supported, use a single attribute key'
        );
      }
      this._key = field.path[0];
    } else {
      throw new UnsupportedPolicyError(
        `matcher field '${field.kind}' is not supported, only span_attribute and trace_field`
      );
    }
    this._predicate = matcher.match;
    this._negate = matcher.negate;
    this._caseInsensitive = matcher.caseInsensitive;
    if (this._predicate.kind === 'regex') {
      const flags = matcher.caseInsensitive ? 'i' : '';
      try {
        this._pattern = new RegExp(this._predicate.pattern, flags);
      } catch (err) {
        throw new UnsupportedPolicyError(
          `invalid regex '${this._predicate.pattern}': ${
            err instanceof Error ? err.message : err
          }`
        );
      }
    } else if (this._predicate.kind !== 'exists') {
      this._text = matcher.caseInsensitive
        ? this._predicate.value.toLowerCase()
        : this._predicate.value;
    }
  }

  public matches(traceIdHex: string, attributes: Attributes): boolean {
    const value = this._isTraceId ? traceIdHex : attributes?.[this._key];
    const predicate = this._predicate;
    let result: boolean;
    if (predicate.kind === 'exists') {
      result = (value != null) === predicate.value;
    } else if (value == null) {
      result = false;
    } else {
      let text = typeof value === 'string' ? value : String(value);
      if (this._pattern !== undefined) {
        result = this._pattern.test(text);
      } else {
        if (this._caseInsensitive) {
          text = text.toLowerCase();
        }
        switch (predicate.kind) {
          case 'exact':
            result = text === this._text;
            break;
          case 'startsWith':
            result = text.startsWith(this._text);
            break;
          case 'endsWith':
            result = text.endsWith(this._text);
            break;
          default: // contains
            result = text.includes(this._text);
            break;
        }
      }
    }
    return this._negate ? !result : result;
  }
}

class CompiledTracePolicy {
  public policyId: string;
  public percentage: number;
  public sampler: Sampler;
  private _matchers: CompiledMatcher[];

  constructor(
    policyId: string,
    match: TraceMatcher[],
    keep: TraceSamplingConfig
  ) {
    if (keep.hashSeed !== 0) {
      // TODO: Need spec clarification on how to hash when seed is present.
      throw new UnsupportedPolicyError('a non-zero hash_seed is not supported');
    }
    this.policyId = policyId;
    this.percentage = keep.percentage;
    this.sampler = new TraceIdRatioBasedSampler(keep.percentage / 100.0);
    this._matchers = match.map(matcher => new CompiledMatcher(matcher));
  }

  public matches(traceIdHex: string, attributes: Attributes): boolean {
    return this._matchers.every(matcher =>
      matcher.matches(traceIdHex, attributes)
    );
  }
}

/** Root sampler evaluating the current trace policy snapshot per span. */
class PolicyRootSampler implements Sampler {
  private _fallback: Sampler;
  private _policies: CompiledTracePolicy[] = [];

  constructor(fallback: Sampler) {
    this._fallback = fallback;
  }

  public setPolicies(policies: CompiledTracePolicy[]): void {
    this._policies = policies.slice();
  }

  public setFallback(fallback: Sampler): void {
    this._fallback = fallback;
  }

  public shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    const policies = this._policies;
    let chosen: CompiledTracePolicy | undefined;
    for (const policy of policies) {
      if (
        (chosen === undefined || policy.percentage < chosen.percentage) &&
        policy.matches(traceId, attributes)
      ) {
        chosen = policy;
      }
    }
    const sampler = chosen !== undefined ? chosen.sampler : this._fallback;
    return sampler.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links
    );
  }

  public toString(): string {
    return `TelemetryPolicyRootSampler{fallback=${this._fallback.toString()}}`;
  }
}

/**
 * Applies trace sampling policies through a runtime-swappable sampler.
 */
export class TraceSamplingPolicyImplementer implements PolicyImplementer {
  private _root: PolicyRootSampler;
  private _sampler: Sampler;

  /**
   * @param fallback root sampler used for spans no policy matches. Defaults
   *     to always-on.
   */
  constructor(fallback?: Sampler) {
    this._root = new PolicyRootSampler(fallback ?? new AlwaysOnSampler());
    this._sampler = new ParentBasedSampler({ root: this._root });
  }

  public get sampler(): Sampler {
    return this._sampler;
  }

  /** Set the root sampler used for spans no policy matches. */
  public setFallback(fallback: Sampler): void {
    this._root.setFallback(fallback);
  }

  public get targetType(): TargetType {
    return 'trace';
  }

  public applyPolicies(policies: Policy[]): PolicyApplyStatus[] {
    const statuses: PolicyApplyStatus[] = [];
    const compiled: CompiledTracePolicy[] = [];
    for (const policy of policies) {
      if (policy.target.type !== 'trace') {
        statuses.push({
          policyId: policy.id,
          applied: false,
          error: 'policy has no trace target',
        });
        continue;
      }
      // Disabled policies must not be evaluated but count as applied.
      if (!policy.enabled) {
        statuses.push({ policyId: policy.id, applied: true, error: '' });
        continue;
      }
      try {
        compiled.push(
          new CompiledTracePolicy(
            policy.id,
            policy.target.match,
            policy.target.keep
          )
        );
      } catch (err) {
        if (err instanceof UnsupportedPolicyError) {
          diag.warn(
            `skipping trace sampling policy '${policy.id}': ${err.message}`
          );
          statuses.push({
            policyId: policy.id,
            applied: false,
            error: err.message,
          });
          continue;
        }
        throw err;
      }
      statuses.push({ policyId: policy.id, applied: true, error: '' });
    }
    this._root.setPolicies(compiled);
    return statuses;
  }
}
