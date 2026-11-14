import { DurableObject } from "cloudflare:workers";
import { EventSubscriptions, type Subscriber, sendCallback } from "./events.ts";
import { eventGrantIsActive, type WorkerEnv } from "./oauth.ts";

/** Stores diagnostic subscriptions for all clients of this Worker. No Parcel credential is persisted here. */
export class ParcelAccount extends DurableObject<WorkerEnv> {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly subscriptions: EventSubscriptions;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.subscriptions = new EventSubscriptions({
      storage: ctx.storage,
      authorized: (owner) => eventGrantIsActive(env, owner),
      send: sendCallback,
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

  alarm() {
    return this.serial(() => this.subscriptions.alarm());
  }
}
