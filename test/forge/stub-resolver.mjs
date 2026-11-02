export default class Resolver { constructor() { this.defs = {}; globalThis.RESOLVERS = this.defs; } define(n, f) { this.defs[n] = f; } getDefinitions() { return this.defs; } }
