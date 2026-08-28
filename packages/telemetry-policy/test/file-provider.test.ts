/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DiagLogLevel, diag } from '@opentelemetry/api';

import { SourceKind } from '../src/model';
import { FilePolicyProvider } from '../src/provider';
import { PolicyStore } from '../src/store';
import { TraceSamplingPolicyImplementer } from '../src/trace-sampling';
import { currentPercentages } from './testutils';

function policyDocument(percentage: number): string {
  return JSON.stringify({
    policies: [
      {
        id: 'sample-database-spans',
        name: 'Sample database spans',
        trace: {
          match: [{ span_attribute: ['db.system'], exists: true }],
          keep: { percentage },
        },
      },
    ],
  });
}

async function waitUntil(
  condition: () => boolean,
  timeoutMillis = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not met within timeout');
}

function load(provider: FilePolicyProvider): void {
  (provider as unknown as { _load(): void })._load();
}

describe('FilePolicyProvider', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-telemetry-policy-'));
    file = path.join(tmpDir, 'policies.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initial load applies policies', async () => {
    fs.writeFileSync(file, policyDocument(0.0));
    const store = new PolicyStore();
    store.addImplementer(new TraceSamplingPolicyImplementer());
    const provider = new FilePolicyProvider({
      path: file,
      store,
      pollIntervalMillis: 0,
    });

    assert.strictEqual(provider.sourceKind, SourceKind.FILE);
    provider.start();
    await provider.shutdown();

    assert.deepStrictEqual(currentPercentages(store), [0.0]);
  });

  it('polling picks up changes', async () => {
    fs.writeFileSync(file, policyDocument(0.0));
    const store = new PolicyStore();
    const provider = new FilePolicyProvider({
      path: file,
      store,
      pollIntervalMillis: 50,
    });

    provider.start();
    try {
      assert.deepStrictEqual(currentPercentages(store), [0.0]);
      fs.writeFileSync(file, policyDocument(100.0));
      await waitUntil(
        () =>
          currentPercentages(store).length === 1 &&
          currentPercentages(store)[0] === 100.0
      );
    } finally {
      await provider.shutdown();
    }
  });

  it('unparseable file keeps previous policies', async () => {
    fs.writeFileSync(file, policyDocument(0.0));
    const store = new PolicyStore();
    const provider = new FilePolicyProvider({
      path: file,
      store,
      pollIntervalMillis: 0,
    });
    provider.start();
    assert.deepStrictEqual(currentPercentages(store), [0.0]);

    fs.writeFileSync(file, '{ not json');
    load(provider);
    assert.deepStrictEqual(currentPercentages(store), [0.0]);

    fs.unlinkSync(file);
    load(provider);
    assert.deepStrictEqual(currentPercentages(store), [0.0]);
  });

  it('unchanged invalid file is not reparsed and recovery applies', async () => {
    fs.writeFileSync(file, policyDocument(0.0));
    const store = new PolicyStore();
    const provider = new FilePolicyProvider({
      path: file,
      store,
      pollIntervalMillis: 0,
    });
    provider.start();

    const warnings: string[] = [];
    diag.setLogger(
      {
        verbose: () => {},
        debug: () => {},
        info: () => {},
        warn: (message: string) => {
          warnings.push(message);
        },
        error: () => {},
      },
      DiagLogLevel.WARN
    );
    try {
      fs.writeFileSync(file, '{ not json');
      load(provider);
      load(provider);
    } finally {
      diag.disable();
    }
    const parseWarnings = warnings.filter(message =>
      message.includes('cannot parse')
    );
    assert.strictEqual(parseWarnings.length, 1);
    assert.deepStrictEqual(currentPercentages(store), [0.0]);

    fs.writeFileSync(file, policyDocument(100.0));
    load(provider);
    assert.deepStrictEqual(currentPercentages(store), [100.0]);
  });

  it('empty document clears policies', async () => {
    fs.writeFileSync(file, policyDocument(0.0));
    const store = new PolicyStore();
    const provider = new FilePolicyProvider({
      path: file,
      store,
      pollIntervalMillis: 0,
    });
    provider.start();
    assert.deepStrictEqual(currentPercentages(store), [0.0]);

    fs.writeFileSync(file, JSON.stringify({ policies: [] }));
    load(provider);
    assert.deepStrictEqual(currentPercentages(store), []);
  });
});
