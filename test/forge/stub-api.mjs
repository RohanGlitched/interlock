export const route = (s, ...v) => s.reduce((a, x, i) => a + x + (i < v.length ? encodeURIComponent(String(v[i])) : ''), '');
export const assumeTrustedRoute = (s) => s;
const mk = () => ({ requestJira: async (path, init) => {
  const out = await globalThis.JIRA(path, init);
  const status = out?.__status || 200;
  const body = out?.__status ? out.body : out;
  return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } };
} });
export default { asUser: mk, asApp: mk };
