// Node stand-in for the Workers runtime module the OAuth library imports.
// Supplies the base context/environment for handler tests and the OAuth library's
// instanceof check. Storage and network are provided by test fixtures.

export class WorkerEntrypoint {
  ctx: unknown;
  env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject extends WorkerEntrypoint {}
