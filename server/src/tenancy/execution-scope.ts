import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantScope } from './scope.js';

const tenantScopeStorage = new AsyncLocalStorage<TenantScope>();

export function runWithTenantScope<T>(scope: TenantScope | undefined, callback: () => Promise<T>): Promise<T> {
  if (!scope) return callback();
  return tenantScopeStorage.run(scope, callback);
}

export function getActiveTenantScope(): TenantScope | undefined {
  return tenantScopeStorage.getStore();
}

export async function* iterateWithTenantScope<T>(scope: TenantScope | undefined, generator: AsyncGenerator<T>): AsyncGenerator<T> {
  while (true) {
    const result = await runWithTenantScope(scope, () => generator.next());
    if (result.done) return;
    yield result.value;
  }
}
