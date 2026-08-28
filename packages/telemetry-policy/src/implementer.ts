/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Policy, PolicyApplyStatus, TargetType } from './model';

/** Applies policies of one target type to the running SDK. */
export interface PolicyImplementer {
  /** The policy target type this implementer handles, e.g. `trace`. */
  readonly targetType: TargetType;

  /** Apply the effective policy set, returning one status per policy. */
  applyPolicies(policies: Policy[]): PolicyApplyStatus[];
}
