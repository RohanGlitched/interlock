import { pathToFileURL } from 'node:url';
const map = { '@forge/api': 'stub-api.mjs', '@forge/resolver': 'stub-resolver.mjs', '@forge/kvs': 'stub-kvs.mjs' };
export async function resolve(spec, ctx, next) {
  if (map[spec]) return { url: new URL(map[spec], import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
