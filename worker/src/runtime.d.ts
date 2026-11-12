/* Минимальные объявления Cloudflare runtime для редактора.
 *
 * Каталог worker/ не входит в корневой typecheck (tsconfig include), поэтому
 * эти типы — только помощь редактору. Истинный контракт API проверяют
 * miniflare-тесты в tests/worker-runtime.test.mjs. */

declare module 'cloudflare:workers' {
  export interface DurableObjectSqlCursor {
    [Symbol.iterator](): Iterator<Record<string, unknown>>;
  }
  export interface DurableObjectSql {
    exec(query: string, ...bindings: (string | number)[]): DurableObjectSqlCursor | undefined;
  }
  export interface DurableObjectCtx {
    storage: { sql: DurableObjectSql };
  }
  export class DurableObject {
    constructor(ctx: DurableObjectCtx, env: unknown);
  }
  export interface DurableObjectNamespace {
    getByName(name: string): unknown;
  }
}

interface SubtleCryptoLike {
  digest(algorithm: string, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
}
declare const crypto: {
  subtle: SubtleCryptoLike;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};
declare function btoa(value: string): string;
declare class TextEncoder {
  encode(value: string): Uint8Array;
}
