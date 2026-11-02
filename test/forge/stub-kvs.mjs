export const store = globalThis.KV = new Map();
export const WhereConditions = { beginsWith: (p) => p };
export const kvs = {
  get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : undefined),
  set: async (k, v, o) => { if (o?.keyPolicy === 'FAIL_IF_EXISTS' && store.has(k)) throw new Error('exists'); store.set(k, structuredClone(v)); },
  delete: async (k) => store.delete(k),
  query: () => { let p = ''; const q = { where: (_, x) => { p = x; return q; }, limit: () => q, cursor: () => q, getMany: async () => ({ results: [...store].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })) }) }; return q; },
};
