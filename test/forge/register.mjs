// Stand-ins for @forge/api, @forge/kvs and @forge/resolver, so the resolvers run in plain Node (test/resolvers.test.mjs)
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
