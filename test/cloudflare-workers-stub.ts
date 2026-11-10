// Node stand-in for the Workers runtime module the OAuth library imports.
// The Parcel handlers are plain fetch objects, so this class only has to exist
// for the library's `instanceof` check. Tests never run inside workerd.

export class WorkerEntrypoint {
  ctx: unknown;
  env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
