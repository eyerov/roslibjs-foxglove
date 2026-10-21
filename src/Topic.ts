import type { Publisher, Subscription } from './Impl';
import type { Ros } from './Ros';

export class Message {
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  constructor(readonly values: any) {
    Object.assign(this, values);
  }
}

export class Topic<TMessage = Message> {
  readonly #ros: Ros;
  readonly #name: string;
  readonly #messageType: string;

  #publisher?: Promise<Publisher<TMessage>>;
  // In-flight promises, not resolved subscriptions: createSubscription waits
  // until the topic is advertised, and unsubscribe() must still find (and
  // later tear down) a subscription requested before that.
  #subscriptions = new Map<
    (message: TMessage) => void,
    Promise<Subscription>
  >();

  constructor(
    readonly options: {
      readonly ros: Ros;
      readonly name: string;
      readonly messageType: string;
    },
  ) {
    this.#ros = options.ros;
    this.#name = options.name;
    this.#messageType = options.messageType;
  }

  get name() {
    return this.#name;
  }

  get messageType() {
    return this.#messageType;
  }

  publish(message: TMessage) {
    if (!this.#publisher) {
      this.advertise();
    }
    this.#publisher?.then((publisher) => {
      publisher.publish(message);
    });
  }

  subscribe(callback: (message: TMessage) => void) {
    const pending = this.#ros.rosImpl?.createSubscription(this.name, callback);
    if (pending) {
      this.#subscriptions.set(callback, pending);
    }
  }

  unsubscribe(callback?: (message: TMessage) => void) {
    const pending = callback
      ? [this.#subscriptions.get(callback)]
      : [...this.#subscriptions.values()];
    if (callback) {
      this.#subscriptions.delete(callback);
    } else {
      this.#subscriptions.clear();
    }
    for (const subscription of pending) {
      subscription?.then(
        (subscription) => subscription.unsubscribe(),
        () => {},
      );
    }
  }

  advertise() {
    this.#publisher = this.#ros.rosImpl?.createPublisher(
      this.name,
      this.messageType,
    );
  }

  unadvertise() {
    this.#publisher?.then((publisher) => {
      publisher.unadvertise();
      this.#publisher = undefined;
    });
  }
}
