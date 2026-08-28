/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { diag } from '@opentelemetry/api';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

import { SourceKind } from './model';
import { parsePolicyDocument } from './parser';
import { PolicyStore } from './store';

/** A source of policy snapshots feeding a {@link PolicyStore}. */
export interface PolicyProvider {
  /** The source kind determining this provider's merge priority. */
  readonly sourceKind: SourceKind;

  /** Start supplying policies to the store. */
  start(): void;

  /** Stop supplying policies. The last snapshot stays in effect. */
  shutdown(): Promise<void>;
}

export interface FilePolicyProviderOptions {
  /** The policy document file. */
  path: string;
  /** The store to push snapshots into. */
  store: PolicyStore;
  /**
   * Milliseconds between change checks. `0` reads the file once at
   * {@link FilePolicyProvider.start} and never again. Default 30000.
   */
  pollIntervalMillis?: number;
}

/** Reads a policy document from a local file, polling it for changes. */
export class FilePolicyProvider implements PolicyProvider {
  private _path: string;
  private _store: PolicyStore;
  private _pollIntervalMillis: number;
  private _digest: Buffer | undefined;
  private _timer: NodeJS.Timeout | undefined;

  constructor(options: FilePolicyProviderOptions) {
    this._path = options.path;
    this._store = options.store;
    this._pollIntervalMillis = options.pollIntervalMillis ?? 30000;
  }

  public get sourceKind(): SourceKind {
    return SourceKind.FILE;
  }

  public start(): void {
    this._load();
    if (this._pollIntervalMillis > 0) {
      this._timer = setInterval(() => {
        this._load();
      }, this._pollIntervalMillis);
      this._timer.unref();
    }
  }

  public async shutdown(): Promise<void> {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  private _load(): void {
    let data: Buffer;
    try {
      data = readFileSync(this._path);
    } catch (err) {
      diag.warn(
        `cannot read policy file '${this._path}', keeping previous policies: ${
          err instanceof Error ? err.message : err
        }`
      );
      return;
    }
    const digest = createHash('sha256').update(data).digest();
    if (this._digest !== undefined && digest.equals(this._digest)) {
      return;
    }
    this._digest = digest;
    let result;
    try {
      result = parsePolicyDocument(data.toString('utf8'));
    } catch (err) {
      diag.warn(
        `cannot parse policy file '${this._path}', keeping previous policies: ${
          err instanceof Error ? err.message : err
        }`
      );
      return;
    }
    for (const error of result.errors) {
      diag.warn(
        `skipping invalid policy '${error.policyId}' in '${this._path}': ${error.message}`
      );
    }
    const statuses = this._store.setPolicies(this.sourceKind, result.policies);
    for (const status of statuses) {
      if (!status.applied) {
        diag.warn(
          `policy '${status.policyId}' from '${this._path}' not applied: ${status.error}`
        );
      }
    }
  }
}
