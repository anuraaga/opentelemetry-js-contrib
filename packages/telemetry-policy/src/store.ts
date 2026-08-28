/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { diag } from '@opentelemetry/api';
import { isDeepStrictEqual } from 'util';

import { PolicyImplementer } from './implementer';
import { Policy, PolicyApplyStatus, SourceKind, TargetType } from './model';

/** Aggregates policy snapshots from providers and applies them. */
export class PolicyStore {
  private _snapshots: Map<SourceKind, Policy[]> = new Map();
  private _implementers: Map<TargetType, PolicyImplementer> = new Map();

  /**
   * Register the implementer for its target type and apply the current
   * effective policies to it.
   */
  public addImplementer(implementer: PolicyImplementer): void {
    const targetType = implementer.targetType;
    if (this._implementers.has(targetType)) {
      throw new Error(
        `an implementer for target type '${targetType}' is already registered`
      );
    }
    this._implementers.set(targetType, implementer);
    const effective = this._effectivePolicies();
    applyToImplementer(
      implementer,
      effective.filter(policy => policy.target.type === targetType)
    );
  }

  /** Replace `source`'s policy snapshot and re-apply the effective set. */
  public setPolicies(
    source: SourceKind,
    policies: Policy[]
  ): PolicyApplyStatus[] {
    this._snapshots.set(source, policies.slice());
    const effective = this._effectivePolicies();
    const effectiveByKey = new Map<string, Policy>();
    for (const policy of effective) {
      effectiveByKey.set(policyKey(policy), policy);
    }

    const statusesByKey = new Map<string, PolicyApplyStatus>();
    for (const [targetType, implementer] of this._implementers) {
      const subset = effective.filter(
        policy => policy.target.type === targetType
      );
      for (const status of applyToImplementer(implementer, subset)) {
        statusesByKey.set(`${targetType}\0${status.policyId}`, status);
      }
    }

    const statuses: PolicyApplyStatus[] = [];
    const seenKeys = new Set<string>();
    for (const policy of policies) {
      const key = policyKey(policy);
      const effectivePolicy = effectiveByKey.get(key);
      const status = statusesByKey.get(key);
      if (!policy.enabled) {
        // A disabled policy is treated as if it does not exist and is a success.
        statuses.push({ policyId: policy.id, applied: true, error: '' });
      } else if (!isDeepStrictEqual(effectivePolicy, policy)) {
        const error = seenKeys.has(key)
          ? 'a different policy earlier in this snapshot with the same id took precedence'
          : 'overridden by a different policy with the same id from a higher-priority source';
        statuses.push({ policyId: policy.id, applied: false, error });
      } else if (status !== undefined) {
        statuses.push(status);
      } else {
        statuses.push({
          policyId: policy.id,
          applied: false,
          error: `no implementer registered for target type '${policy.target.type}'`,
        });
      }
      seenKeys.add(key);
    }
    return statuses;
  }

  private _effectivePolicies(): Policy[] {
    const merged = new Map<string, Policy>();
    const sources = [...this._snapshots.keys()].sort((a, b) => a - b);
    for (const source of sources) {
      for (const policy of this._snapshots.get(source)!) {
        if (!policy.enabled) {
          continue;
        }
        const key = policyKey(policy);
        if (merged.has(key)) {
          continue;
        }
        merged.set(key, policy);
      }
    }
    return [...merged.values()].sort((a, b) => {
      if (a.target.type !== b.target.type) {
        return a.target.type < b.target.type ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
}

function policyKey(policy: Policy): string {
  return `${policy.target.type}\0${policy.id}`;
}

function applyToImplementer(
  implementer: PolicyImplementer,
  policies: Policy[]
): PolicyApplyStatus[] {
  try {
    return implementer.applyPolicies(policies);
  } catch (err) {
    diag.error(
      `policy implementer for '${implementer.targetType}' failed`,
      err
    );
    return policies.map(policy => ({
      policyId: policy.id,
      applied: false,
      error: `implementer failed: ${err instanceof Error ? err.message : err}`,
    }));
  }
}
