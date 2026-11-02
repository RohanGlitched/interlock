// An MCP client outside Rovo: connects to Interlock's Forge MCP server through Atlassian's MCP endpoint with OAuth 2.1,
// lists the tools and calls prove-route on the Ship workflow. Tokens stay in memory. Output goes to out.json.
// Usage: npm install, then node client.mjs <interlock-app-id>; open the URL in authorize-url.txt and accept.
// An admin must first turn on "Expose tools to MCP-compatible apps" for Interlock (Atlassian Administration >
// Apps > Sites > your site > Connected apps > Interlock).
import http from 'node:http';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = new URL('https://mcp.atlassian.com/forge/' + (process.argv[2] || 'c6e3cd9f-d392-4c9e-b878-c372c23c1c8a'));
const REDIRECT = 'http://127.0.0.1:8899/callback';
const dir = new URL('.', import.meta.url);
const log = (...a) => { console.log(...a); fs.appendFileSync(new URL('log.txt', dir), a.join(' ') + '\n'); };

let info, tokens, verifier;
const provider = {
  get redirectUrl() { return REDIRECT; },
  get clientMetadata() {
    return { client_name: 'Interlock MCP check (Codegeist demo)', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  },
  clientInformation: () => info,
  saveClientInformation: (i) => { info = i; },
  tokens: () => tokens,
  saveTokens: (t) => { tokens = t; },
  redirectToAuthorization: (u) => { fs.writeFileSync(new URL('authorize-url.txt', dir), u.toString()); log('AUTHORIZE_URL_WRITTEN'); },
  saveCodeVerifier: (v) => { verifier = v; },
  codeVerifier: () => verifier,
};

const codeP = new Promise((resolve) => {
  http.createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== '/callback') { res.end(); return; }
    res.end('Interlock MCP check: authorized. You can close this tab.');
    resolve(u.searchParams.get('code'));
  }).listen(8899, '127.0.0.1');
});

let transport = new StreamableHTTPClientTransport(URL_, { authProvider: provider });
const client = new Client({ name: 'interlock-mcp-check', version: '1.0.0' });
try { await client.connect(transport); }
catch (e) {
  log('needs auth:', e.constructor.name);
  const code = await codeP;
  await transport.finishAuth(code);
  transport = new StreamableHTTPClientTransport(URL_, { authProvider: provider });
  await client.connect(transport);
}
log('CONNECTED', JSON.stringify(client.getServerVersion()));
const tools = await client.listTools();
log('TOOLS', tools.tools.map((t) => t.name).join(', '));
const pick = tools.tools.find((t) => /prove-route/.test(t.name));
const args = { workflow: 'Ship: Software delivery workflow', target: 'Done', through: 'Code Review' };
const out = await client.callTool({ name: pick.name, arguments: args });
fs.writeFileSync(new URL('out.json', dir), JSON.stringify({ at: new Date().toISOString(), endpoint: URL_.toString(), server: client.getServerVersion(), tools: tools.tools.map((t) => ({ name: t.name, description: t.description })), call: { name: pick.name, arguments: args }, result: out }, null, 2));
log('DONE');
await client.close();
process.exit(0);
