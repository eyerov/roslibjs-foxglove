import EventEmitter from 'eventemitter3';

import type { Impl, Subscription } from './Impl';
import type { Ros } from './Ros';
import { errorMessage } from './Service';

/**
 * Goal states, from action_msgs/msg/GoalStatus. Same names as roslibjs.
 */
export enum GoalStatus {
  STATUS_UNKNOWN = 0,
  STATUS_ACCEPTED = 1,
  STATUS_EXECUTING = 2,
  STATUS_CANCELING = 3,
  STATUS_SUCCEEDED = 4,
  STATUS_CANCELED = 5,
  STATUS_ABORTED = 6,
}

export interface CancelGoalResponse {
  /** 0 NONE, 1 REJECTED, 2 UNKNOWN_GOAL_ID, 3 GOAL_TERMINATED. */
  return_code: number;
  goals_canceling: { goal_id: { uuid: Uint8Array }; stamp: RosTime }[];
}

export interface ActionEventTypes {
  /** A goal sent by this client changed state (including its final state). */
  status: (goalId: string, status: GoalStatus) => void;
}

interface RosTime {
  sec: number;
  nanosec: number;
}

type Uuid = { uuid: Uint8Array | number[] };

interface GoalStatusArray {
  status_list: { goal_info: { goal_id: Uuid }; status: number }[];
}

// How long a send_goal / cancel_goal round trip may take by default, including
// waiting for the bridge to advertise the service.
const DEFAULT_TIMEOUT_MS = 5000;
// Once status reports a terminal state, how long the pending get_result may
// stay unanswered before it is re-issued (it can be lost across a bridge blip).
const RESULT_GRACE_MS = 3000;

// Like Service, message types are untyped unless the caller supplies them.
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type Untyped = any;

const ZERO_TIME: RosTime = { sec: 0, nanosec: 0 };

const toHex = (uuid: Uuid['uuid']) =>
  Array.from(uuid, (byte) => byte.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string) =>
  /^[0-9a-f]{32}$/i.test(hex)
    ? Uint8Array.from(hex.match(/../g) ?? [], (byte) =>
        Number.parseInt(byte, 16),
      )
    : undefined;

const newUuid = () => {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // RFC 4122 version 4.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytes;
};

const isTerminal = (status: number) =>
  status === GoalStatus.STATUS_SUCCEEDED ||
  status === GoalStatus.STATUS_CANCELED ||
  status === GoalStatus.STATUS_ABORTED;

/**
 * Whether `fields` (a schema's top-level fields) wrap the action payload in a
 * single `<field>` of type `*<suffix>`, as the ROS 2 IDL defines it, rather
 * than inlining the payload's fields. foxglove_bridge inlines them: e.g.
 * `<Action>_SendGoal_Request` is advertised as `goal_id` followed by the
 * goal's own fields, not `goal_id` + `goal`. The CDR bytes are identical
 * either way, but the message object must match the advertised schema.
 */
const isWrapped = (
  fields: Map<string, string> | undefined,
  field: string,
  suffix: string,
) => fields?.get(field)?.endsWith(suffix) ?? false;

/**
 * A ROS 2 action client, with the same interface as roslibjs's `Action`.
 *
 * The Foxglove WebSocket protocol has no notion of actions, so this composes
 * the services and topics every ROS 2 action is built from:
 *
 * - `<name>/_action/send_goal`   (service) submit a goal; accepted or rejected
 * - `<name>/_action/get_result`  (service) answers once the goal has finished
 * - `<name>/_action/cancel_goal` (service) action_msgs/srv/CancelGoal
 * - `<name>/_action/feedback`    (topic)   feedback for every goal
 * - `<name>/_action/status`      (topic)   action_msgs/msg/GoalStatusArray
 *
 * These names are hidden in ROS 2, so foxglove_bridge must be started with
 * `include_hidden:=true`; otherwise nothing is advertised and every goal fails
 * after `timeout`.
 *
 * Acting as an action server (roslibjs's `advertise`) is not supported: the
 * Foxglove protocol cannot advertise services from the client.
 */
export class Action<
  TGoal = Untyped,
  TFeedback = Untyped,
  TResult = Untyped,
> extends EventEmitter<ActionEventTypes> {
  readonly #ros: Ros;
  readonly #name: string;
  readonly #actionType: string;
  readonly #timeout: number;
  readonly #goals = new Map<string, Uint8Array>();

  constructor(
    readonly options: {
      readonly ros: Ros;
      /** Action name, like '/fibonacci'. */
      readonly name: string;
      /** Action type, like 'example_interfaces/action/Fibonacci'. */
      readonly actionType: string;
      /**
       * Milliseconds to wait for send_goal and cancel_goal to be answered,
       * including waiting for them to be advertised. Defaults to 5000.
       */
      readonly timeout?: number;
    },
  ) {
    super();
    this.#ros = options.ros;
    this.#name = options.name.replace(/\/+$/, '');
    this.#actionType = options.actionType;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  get name() {
    return this.#name;
  }

  get actionType() {
    return this.#actionType;
  }

  /**
   * Sends a goal and returns its ID (the goal UUID as hex).
   *
   * `resultCallback` is called with the result if the goal succeeds.
   * `failedCallback` is called if the goal is rejected, aborted or canceled,
   * or if the server cannot be reached or the connection closes; for aborted
   * and canceled goals it also receives the result the server returned.
   * Every state change is also emitted as a `status` event.
   */
  sendGoal(
    goal: TGoal,
    resultCallback: (result: TResult) => void,
    feedbackCallback?: (feedback: TFeedback) => void,
    failedCallback?: (error: string, result?: TResult) => void,
  ): string {
    const uuid = newUuid();
    const goalId = toHex(uuid);
    const impl = this.#ros.rosImpl;
    if (!impl) {
      queueMicrotask(() => failedCallback?.('Not connected'));
      return goalId;
    }
    this.#goals.set(goalId, uuid);
    new ActiveGoal<TGoal, TFeedback, TResult>(
      impl,
      this.#name,
      this.#timeout,
      uuid,
      goal,
      {
        onResult: resultCallback,
        onFeedback: feedbackCallback,
        onFailed: failedCallback,
        onStatus: (status) => this.emit('status', goalId, status),
        onDone: () => this.#goals.delete(goalId),
      },
    );
    return goalId;
  }

  /**
   * Requests cancellation of a goal sent by this client (or of any goal, given
   * its UUID as hex). The goal's outcome is still reported through the
   * callbacks passed to `sendGoal`.
   */
  cancelGoal(
    id: string,
    callback?: (response: CancelGoalResponse) => void,
    failedCallback?: (error: string) => void,
  ) {
    const uuid = this.#goals.get(id) ?? fromHex(id);
    const impl = this.#ros.rosImpl;
    if (!uuid || !impl) {
      queueMicrotask(() =>
        failedCallback?.(uuid ? 'Not connected' : `Invalid goal ID "${id}"`),
      );
      return;
    }
    impl
      .sendServiceRequest<unknown, CancelGoalResponse>(
        `${this.#name}/_action/cancel_goal`,
        { goal_info: { goal_id: { uuid }, stamp: ZERO_TIME } },
        this.#timeout,
      )
      .then((response) => callback?.(response))
      .catch((error: unknown) => failedCallback?.(errorMessage(error)));
  }
}

interface GoalCallbacks<TFeedback, TResult> {
  onResult: (result: TResult) => void;
  onFeedback?: (feedback: TFeedback) => void;
  onFailed?: (error: string, result?: TResult) => void;
  onStatus: (status: GoalStatus) => void;
  onDone: () => void;
}

/**
 * One submitted goal: listens for its feedback and status, then reports its
 * outcome exactly once, from whichever source settles first — get_result, the
 * status topic (if get_result is lost), or the connection closing.
 */
class ActiveGoal<TGoal, TFeedback, TResult> {
  readonly #impl: Impl;
  readonly #base: string;
  readonly #timeout: number;
  readonly #uuid: Uint8Array;
  readonly #goalId: string;
  readonly #callbacks: GoalCallbacks<TFeedback, TResult>;
  readonly #subscriptions: Promise<Subscription>[];
  #status: number = GoalStatus.STATUS_UNKNOWN;
  #done = false;
  #graceTimer?: ReturnType<typeof setTimeout>;

  constructor(
    impl: Impl,
    name: string,
    timeout: number,
    uuid: Uint8Array,
    goal: TGoal,
    callbacks: GoalCallbacks<TFeedback, TResult>,
  ) {
    this.#impl = impl;
    this.#base = `${name}/_action`;
    this.#timeout = timeout;
    this.#uuid = uuid;
    this.#goalId = toHex(uuid);
    this.#callbacks = callbacks;

    // Subscribe before submitting, so early feedback and status aren't missed.
    this.#subscriptions = [
      impl.createSubscription(`${this.#base}/feedback`, this.#onFeedback),
      impl.createSubscription(`${this.#base}/status`, this.#onStatus),
    ];
    impl.emitter.on('close', this.#onClose);

    this.#submit(goal).catch((error: unknown) =>
      this.#fail(errorMessage(error)),
    );
  }

  async #submit(goal: TGoal) {
    if (await this.#impl.isRos1()) {
      throw new Error('Actions are only supported on ROS 2');
    }
    const sendGoal = `${this.#base}/send_goal`;
    const deadline = Date.now() + this.#timeout;
    const fields = await this.#impl.getServiceFields(
      sendGoal,
      'request',
      this.#timeout,
    );
    const goalId = { uuid: this.#uuid };
    const request = isWrapped(fields, 'goal', '_Goal')
      ? { goal_id: goalId, goal }
      : { ...goal, goal_id: goalId };
    const response = await this.#impl.sendServiceRequest<
      unknown,
      { accepted: boolean }
    >(sendGoal, request, Math.max(0, deadline - Date.now()));
    if (this.#done) {
      return;
    }
    if (!response.accepted) {
      this.#fail('Goal was rejected');
      return;
    }
    this.#fetchResult().catch(() => {
      // Leave it to the status fallback; if status never turns terminal
      // either, the connection closing still settles the goal.
    });
  }

  async #fetchResult(timeout?: number) {
    const getResult = `${this.#base}/get_result`;
    const response = await this.#impl.sendServiceRequest<
      { goal_id: Uuid },
      { status: number; result?: unknown } & Record<string, unknown>
    >(getResult, { goal_id: { uuid: this.#uuid } }, timeout);
    const fields = await this.#impl.getServiceFields(
      getResult,
      'response',
      this.#timeout,
    );
    const { status, ...rest } = response;
    const result = (
      isWrapped(fields, 'result', '_Result') ? rest.result : rest
    ) as TResult;
    this.#finish(status, result);
  }

  #finish(status: number, result?: TResult) {
    if (this.#done) {
      return;
    }
    this.#setStatus(status);
    if (status === GoalStatus.STATUS_SUCCEEDED) {
      this.#end();
      this.#callbacks.onResult(result as TResult);
    } else {
      const state =
        status === GoalStatus.STATUS_CANCELED
          ? 'canceled'
          : status === GoalStatus.STATUS_ABORTED
            ? 'aborted'
            : `finished with status ${status}`;
      this.#fail(`Goal was ${state}`, result);
    }
  }

  #fail(error: string, result?: TResult) {
    if (this.#done) {
      return;
    }
    this.#end();
    this.#callbacks.onFailed?.(error, result);
  }

  #end() {
    this.#done = true;
    clearTimeout(this.#graceTimer);
    for (const subscription of this.#subscriptions) {
      subscription.then(
        (subscription) => subscription.unsubscribe(),
        () => {},
      );
    }
    this.#impl.emitter.off('close', this.#onClose);
    this.#callbacks.onDone();
  }

  #setStatus(status: number) {
    if (status !== this.#status) {
      this.#status = status;
      this.#callbacks.onStatus(status);
    }
  }

  readonly #onFeedback = (
    message: { goal_id: Uuid; feedback?: unknown } & Record<string, unknown>,
  ) => {
    if (this.#done || toHex(message.goal_id.uuid) !== this.#goalId) {
      return;
    }
    const fields = this.#impl.getTopicFields(`${this.#base}/feedback`);
    const { goal_id: _, ...rest } = message;
    this.#callbacks.onFeedback?.(
      (isWrapped(fields, 'feedback', '_Feedback')
        ? rest.feedback
        : rest) as TFeedback,
    );
  };

  readonly #onStatus = (message: GoalStatusArray) => {
    if (this.#done) {
      return;
    }
    const entry = message.status_list.find(
      (entry) => toHex(entry.goal_info.goal_id.uuid) === this.#goalId,
    );
    if (!entry) {
      return;
    }
    this.#setStatus(entry.status);
    if (isTerminal(entry.status) && this.#graceTimer === undefined) {
      // The pending get_result should answer momentarily. If it was lost, ask
      // again, and settle on the status alone if that fails too.
      const status = entry.status;
      this.#graceTimer = setTimeout(() => {
        this.#fetchResult(this.#timeout).catch(() => this.#finish(status));
      }, RESULT_GRACE_MS);
    }
  };

  readonly #onClose = () => {
    this.#fail('Connection closed');
  };
}
