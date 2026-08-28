/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';

import { PolicyImplementer } from '../src/implementer';
import {
  Policy,
  PolicyApplyStatus,
  SourceKind,
  TargetType,
} from '../src/model';
import { PolicyStore } from '../src/store';
import { logPolicy, tracePolicy } from './testutils';

class RecordingImplementer implements PolicyImplementer {
  calls: Policy[][] = [];

  constructor(readonly targetType: TargetType = 'trace') {}

  applyPolicies(policies: Policy[]): PolicyApplyStatus[] {
    this.calls.push(policies.slice());
    return policies.map(policy => ({
      policyId: policy.id,
      applied: true,
      error: '',
    }));
  }
}

class CrashingImplementer implements PolicyImplementer {
  readonly targetType: TargetType = 'trace';

  applyPolicies(): PolicyApplyStatus[] {
    throw new Error('boom');
  }
}

describe('PolicyStore', () => {
  it('applies and acknowledges policies', () => {
    const store = new PolicyStore();
    const implementer = new RecordingImplementer();
    store.addImplementer(implementer);
    const policy = tracePolicy('p1');

    const statuses = store.setPolicies(SourceKind.FILE, [policy]);

    assert.deepStrictEqual(statuses, [
      { policyId: 'p1', applied: true, error: '' },
    ]);
    assert.deepStrictEqual(implementer.calls[implementer.calls.length - 1], [
      policy,
    ]);
  });

  it('addImplementer applies current policies', () => {
    const store = new PolicyStore();
    const policy = tracePolicy('p1');
    store.setPolicies(SourceKind.FILE, [policy]);

    const implementer = new RecordingImplementer();
    store.addImplementer(implementer);

    assert.deepStrictEqual(implementer.calls, [[policy]]);
  });

  it('rejects a duplicate implementer target', () => {
    const store = new PolicyStore();
    store.addImplementer(new RecordingImplementer());
    assert.throws(() => store.addImplementer(new RecordingImplementer()));
  });

  it('full snapshot replacement removes old policies', () => {
    const store = new PolicyStore();
    const implementer = new RecordingImplementer();
    store.addImplementer(implementer);
    store.setPolicies(SourceKind.FILE, [tracePolicy('p1'), tracePolicy('p2')]);

    const newPolicy = tracePolicy('p3');
    store.setPolicies(SourceKind.FILE, [newPolicy]);

    assert.deepStrictEqual(implementer.calls[implementer.calls.length - 1], [
      newPolicy,
    ]);

    store.setPolicies(SourceKind.FILE, []);
    assert.deepStrictEqual(implementer.calls[implementer.calls.length - 1], []);
  });

  it('higher priority source wins duplicate policy id', () => {
    const store = new PolicyStore();
    const implementer = new RecordingImplementer();
    store.addImplementer(implementer);
    const filePolicy = tracePolicy('p1', { percentage: 50.0 });
    const opampPolicy = tracePolicy('p1', { percentage: 5.0 });

    let fileStatuses = store.setPolicies(SourceKind.FILE, [filePolicy]);
    assert.strictEqual(fileStatuses[0].applied, true);

    const opampStatuses = store.setPolicies(SourceKind.OPAMP, [opampPolicy]);
    assert.strictEqual(opampStatuses[0].applied, true);
    assert.deepStrictEqual(implementer.calls[implementer.calls.length - 1], [
      opampPolicy,
    ]);

    // Re-sending the file snapshot reports the loss to the file source and
    // keeps the OpAMP policy in effect.
    fileStatuses = store.setPolicies(SourceKind.FILE, [filePolicy]);
    assert.strictEqual(fileStatuses[0].applied, false);
    assert.ok(fileStatuses[0].error.includes('higher-priority'));
    assert.deepStrictEqual(implementer.calls[implementer.calls.length - 1], [
      opampPolicy,
    ]);
  });

  it('disabled policy does not exist for merging', () => {
    const store = new PolicyStore();
    const implementer = new RecordingImplementer();
    store.addImplementer(implementer);
    const disabledOpamp = tracePolicy('p1', {
      percentage: 0.0,
      enabled: false,
    });
    const enabledFile = tracePolicy('p1', { percentage: 0.0 });

    const opampStatuses = store.setPolicies(SourceKind.OPAMP, [disabledOpamp]);
    const fileStatuses = store.setPolicies(SourceKind.FILE, [enabledFile]);

    assert.deepStrictEqual(opampStatuses, [
      { policyId: 'p1', applied: true, error: '' },
    ]);
    assert.deepStrictEqual(fileStatuses, [
      { policyId: 'p1', applied: true, error: '' },
    ]);
    assert.deepStrictEqual(implementer.calls[implementer.calls.length - 1], [
      enabledFile,
    ]);
  });

  it('disabled policy without implementer counts as applied', () => {
    const store = new PolicyStore();

    const statuses = store.setPolicies(SourceKind.FILE, [
      logPolicy('p1', false),
    ]);

    assert.deepStrictEqual(statuses, [
      { policyId: 'p1', applied: true, error: '' },
    ]);
  });

  it('duplicate id within snapshot first wins', () => {
    const store = new PolicyStore();
    const implementer = new RecordingImplementer();
    store.addImplementer(implementer);
    const first = tracePolicy('p1', { percentage: 0.0 });
    const second = tracePolicy('p1', { percentage: 100.0 });

    const statuses = store.setPolicies(SourceKind.FILE, [first, second]);

    assert.strictEqual(statuses[0].applied, true);
    assert.strictEqual(statuses[1].applied, false);
    assert.ok(statuses[1].error.includes('earlier in this snapshot'));
    assert.deepStrictEqual(implementer.calls[implementer.calls.length - 1], [
      first,
    ]);
  });

  it('identical duplicate from lower priority source is applied', () => {
    const store = new PolicyStore();
    store.addImplementer(new RecordingImplementer());
    const policy = tracePolicy('p1');
    store.setPolicies(SourceKind.OPAMP, [policy]);

    const statuses = store.setPolicies(SourceKind.FILE, [policy]);

    assert.strictEqual(statuses[0].applied, true);
  });

  it('no implementer reports not applied', () => {
    const store = new PolicyStore();
    store.addImplementer(new RecordingImplementer('trace'));

    const statuses = store.setPolicies(SourceKind.FILE, [
      logPolicy('p1'),
      tracePolicy('p2'),
    ]);

    assert.strictEqual(statuses[0].applied, false);
    assert.ok(statuses[0].error.includes('no implementer'));
    assert.strictEqual(statuses[1].applied, true);
  });

  it('crashing implementer fails open', () => {
    const store = new PolicyStore();
    store.addImplementer(new CrashingImplementer());

    const statuses = store.setPolicies(SourceKind.FILE, [tracePolicy('p1')]);

    assert.strictEqual(statuses[0].applied, false);
    assert.ok(statuses[0].error.includes('implementer failed'));
  });
});
