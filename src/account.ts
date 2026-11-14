import { DurableObject } from "cloudflare:workers";
import { isObject } from "./body.ts";
import { EventSubscriptions, type Subscriber, sendCallback } from "./events.ts";
import { eventGrantIsActive, type WorkerEnv } from "./oauth.ts";
import { ParcelReads, type Snapshot } from "./rate.ts";

/** Coordinates delivery reads and subscriptions for all clients of this Worker. No Parcel credential is persisted here. */
export class ParcelAccount extends DurableObject<WorkerEnv> {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly reads: ParcelReads;
  private readonly subscriptions: EventSubscriptions;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.reads = new ParcelReads({ storage: ctx.storage, key: env.PARCEL_API_KEY ?? "" });
    this.subscriptions = new EventSubscriptions({
      storage: ctx.storage,
      authorized: (owner) => eventGrantIsActive(env, owner),
      send: sendCallback,
      read: () => this.reads.read(),
    });
  }

  // Serializes application operations without blocking the runtime across I/O.
  // Storage and the alarm survive eviction; the queue only orders live requests.
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => {});
    return pending;
  }

  events(method: string, params: unknown, owner: Subscriber) {
    return this.serial(() => this.subscriptions.handle(method, params, owner));
  }

  read() {
    return this.serial(async () => {
      const result = await this.reads.read();
      if (
        !result.isError &&
        isObject(result.structuredContent) &&
        result.structuredContent.stale === false
      )
        await this.subscriptions.observe(result.structuredContent as Snapshot);
      return result;
    });
  }

  alarm() {
    return this.serial(() => this.subscriptions.alarm());
  }
}
