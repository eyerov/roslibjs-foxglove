import { parse, parseRos2idl } from '@foxglove/rosmsg';
import {
  MessageReader as Ros1MessageReader,
  MessageWriter as Ros1MessageWriter,
} from '@foxglove/rosmsg-serialization';
import {
  MessageReader as Ros2MessageReader,
  MessageWriter as Ros2MessageWriter,
} from '@foxglove/rosmsg2-serialization';
import {
  type Channel,
  type ConnectionGraphUpdate,
  FoxgloveClient,
  type MessageData,
  type Parameter,
  type ParameterValue,
  type ParameterValues,
  type Service,
  type ServiceCallFailure,
  type ServiceCallResponse,
} from '@foxglove/ws-protocol';
import EventEmitter from 'eventemitter3';
import WebSocket from 'isomorphic-ws';

export interface EventTypes {
  connection: () => void;
  close: (event: CloseEvent) => void;
  error: (error: Error) => void;
}

export interface Publisher<T> {
  publish: (message: T) => void;
  unadvertise: () => void;
}

export interface Subscription {
  unsubscribe: () => void;
}

type SchemaInfo = {
  name: string;
  schemaEncoding: string | undefined;
  schema: string | undefined;
};

/**
 * Request or response schema of a service. `foxglove.sdk.v1` servers describe
 * them in `request` / `response`; older servers only send the deprecated
 * `requestSchema` / `responseSchema` strings, named after the service type.
 */
function serviceSchema(
  service: Service,
  part: 'request' | 'response',
): SchemaInfo {
  const definition = service[part];
  if (definition) {
    return {
      name: definition.schemaName,
      schemaEncoding: definition.schemaEncoding,
      schema: definition.schema,
    };
  }
  return {
    name: `${service.type}_${part === 'request' ? 'Request' : 'Response'}`,
    schemaEncoding: undefined,
    schema: part === 'request' ? service.requestSchema : service.responseSchema,
  };
}

export class Impl {
  readonly emitter = new EventEmitter<EventTypes>();

  #client: FoxgloveClient;
  #connecting: Promise<void>;
  #isRos1?: boolean;

  // Message Readers / Writers
  #messageReaders = new Map<string, Ros1MessageReader | Ros2MessageReader>();
  #messageWriters = new Map<string, Ros1MessageWriter | Ros2MessageWriter>();

  // Channels
  #channelsById = new Map<number, Channel>();
  #channelsByName = new Map<string, Channel>();

  // Services
  #servicesById = new Map<number, Service>();
  #servicesByName = new Map<string, Service>();

  #publisherIdsWithCount = new Map<string, { id: number; count: number }>();
  #subscriptionIdsWithCount = new Map<string, { id: number; count: number }>();

  #callId = 0;
  #paramId = 0;

  constructor(url: string) {
    this.#client = new FoxgloveClient({
      ws: new WebSocket(url, [
        'foxglove.sdk.v1',
        FoxgloveClient.SUPPORTED_SUBPROTOCOL,
      ]),
    });

    const open = new Promise<void>((resolve) => {
      this.#client.on('open', resolve);
    });
    const serverInfo = new Promise<void>((resolve) => {
      this.#client.on('serverInfo', (event) => {
        this.#isRos1 = event.supportedEncodings?.includes('ros1') ?? false;
        resolve();
      });
    });

    this.#client.on('close', (event) => {
      this.emitter.emit('close', event);
    });
    this.#client.on('error', (error?: Error) => {
      this.emitter.emit('error', error ?? new Error('WebSocket error'));
    });

    this.#client.on('advertise', (channels) => {
      for (const channel of channels) {
        this.#channelsById.set(channel.id, channel);
        this.#channelsByName.set(channel.topic, channel);
      }
    });
    this.#client.on('unadvertise', (channelIds) => {
      for (const channelId of channelIds) {
        const channel = this.#channelsById.get(channelId);
        if (channel) {
          this.#channelsById.delete(channel.id);
          this.#channelsByName.delete(channel.topic);
        }
      }
    });

    this.#client.on('advertiseServices', (services) => {
      for (const service of services) {
        this.#servicesById.set(service.id, service);
        this.#servicesByName.set(service.name, service);
      }
    });
    this.#client.on('unadvertiseServices', (serviceIds) => {
      for (const serviceId of serviceIds) {
        const service = this.#servicesById.get(serviceId);
        if (service) {
          this.#servicesById.delete(service.id);
          this.#servicesByName.delete(service.name);
        }
      }
    });

    this.#connecting = new Promise<void>((resolve) => {
      Promise.all([open, serverInfo]).then(() => {
        this.emitter.emit('connection');
        resolve();
      });
    });
  }

  close() {
    this.#client.close();
  }

  getTopics() {
    return {
      topics: [...this.#channelsByName.keys()],
      types: [...this.#channelsByName.values()].map((x) => x.schemaName),
    };
  }

  async getServices() {
    await this.#connecting;
    return new Promise<string[]>((resolve) => {
      const listener = (event: ConnectionGraphUpdate) => {
        this.#client.off('connectionGraphUpdate', listener);
        this.#client.unsubscribeConnectionGraph();
        resolve(event.advertisedServices.map((service) => service.name));
      };
      this.#client.on('connectionGraphUpdate', listener);
      this.#client.subscribeConnectionGraph();
    });
  }

  getTopicType(topic: string) {
    return this.#channelsByName.get(topic)?.schemaName;
  }

  getServiceType(service: string) {
    return this.#servicesByName.get(service)?.type;
  }

  async createPublisher<T>(
    name: string,
    messageType: string,
  ): Promise<Publisher<T>> {
    await this.#connecting;
    const channel = this.#getChannel(name);

    const publisherId = (() => {
      const idWithCount = this.#publisherIdsWithCount.get(name);
      if (idWithCount) {
        idWithCount.count++;
        return idWithCount.id;
      }
      const publisherId = this.#client.advertise({
        topic: name,
        encoding: this.#isRos1 ? 'ros1' : 'cdr',
        schemaName: messageType,
      });
      this.#publisherIdsWithCount.set(name, { id: publisherId, count: 1 });
      return publisherId;
    })();

    const writer = this.#getMessageWriter(await channel);

    return {
      publish: (message: T) => {
        this.#client.sendMessage(publisherId, writer.writeMessage(message));
      },
      unadvertise: () => {
        const idWithCount = this.#publisherIdsWithCount.get(name);
        if (idWithCount) {
          idWithCount.count--;
          if (idWithCount.count === 0) {
            this.#publisherIdsWithCount.delete(name);
            this.#client.unadvertise(publisherId);
          }
        }
      },
    };
  }

  async createSubscription<T>(
    name: string,
    callback: (message: T) => void,
  ): Promise<Subscription> {
    await this.#connecting;
    const channel = await this.#getChannel(name);

    const subscriptionId = (() => {
      const idWithCount = this.#subscriptionIdsWithCount.get(name);
      if (idWithCount) {
        idWithCount.count++;
        return idWithCount.id;
      }
      const subscriptionId = this.#client.subscribe(channel.id);
      this.#subscriptionIdsWithCount.set(name, {
        id: subscriptionId,
        count: 1,
      });
      return subscriptionId;
    })();

    const reader = this.#getMessageReader(channel);

    const listener = (event: MessageData) => {
      if (event.subscriptionId === subscriptionId) {
        callback(reader.readMessage(event.data));
      }
    };
    this.#client.on('message', listener);

    return {
      unsubscribe: () => {
        this.#client.off('message', listener);
        const idWithCount = this.#subscriptionIdsWithCount.get(name);
        if (idWithCount) {
          idWithCount.count--;
          if (idWithCount.count === 0) {
            this.#subscriptionIdsWithCount.delete(name);
            this.#client.unsubscribe(subscriptionId);
          }
        }
      },
    };
  }

  /**
   * Calls a service. Rejects when the bridge reports a `serviceCallFailure`,
   * when the connection closes before a response arrives, or — if `timeoutMs`
   * is given — when the service is not advertised and answered in time.
   */
  async sendServiceRequest<Request, Response>(
    name: string,
    request: Request,
    timeoutMs?: number,
  ) {
    const deadline =
      timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const service = await this.#getService(name, timeoutMs);
    const writer = this.#getMessageWriter(service);
    const reader = this.#getMessageReader(service);

    const callId = this.#callId++;
    return new Promise<Response>((resolve, reject) => {
      const cleanup = () => {
        this.#client.off('serviceCallResponse', onResponse);
        this.#client.off('serviceCallFailure', onFailure);
        this.emitter.off('close', onClose);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };
      const onResponse = (event: ServiceCallResponse) => {
        if (event.serviceId === service.id && event.callId === callId) {
          cleanup();
          try {
            resolve(reader.readMessage(event.data));
          } catch (error) {
            reject(error);
          }
        }
      };
      const onFailure = (event: ServiceCallFailure) => {
        if (event.serviceId === service.id && event.callId === callId) {
          cleanup();
          reject(
            new Error(`Service call to "${name}" failed: ${event.message}`),
          );
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`Connection closed during service call to "${name}"`));
      };
      const timer =
        deadline === undefined
          ? undefined
          : setTimeout(
              () => {
                cleanup();
                reject(
                  new Error(
                    `Service "${name}" did not respond within ${timeoutMs} ms`,
                  ),
                );
              },
              Math.max(0, deadline - Date.now()),
            );
      this.#client.on('serviceCallResponse', onResponse);
      this.#client.on('serviceCallFailure', onFailure);
      this.emitter.on('close', onClose);
      try {
        this.#client.sendServiceCallRequest({
          serviceId: service.id,
          callId,
          encoding: this.#isRos1 ? 'ros1' : 'cdr',
          data: new DataView(writer.writeMessage(request).buffer),
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async getParameter(name: string) {
    await this.#connecting;
    const paramId = (this.#paramId++).toString();
    return new Promise<ParameterValue>((resolve) => {
      const listener = (event: ParameterValues) => {
        if (event.parameters[0]?.name === name && event.id === paramId) {
          this.#client.off('parameterValues', listener);
          resolve(event.parameters[0].value);
        }
      };
      this.#client.on('parameterValues', listener);
      this.#client.getParameters([name], paramId);
    });
  }

  async setParameter(name: string, value: ParameterValue) {
    await this.#connecting;
    const paramId = (this.#paramId++).toString();
    return new Promise<Parameter>((resolve) => {
      const listener = (event: ParameterValues) => {
        if (event.parameters[0]?.name === name && event.id === paramId) {
          this.#client.off('parameterValues', listener);
          resolve(event.parameters[0]);
        }
      };
      this.#client.on('parameterValues', listener);
      this.#client.setParameters([{ name: name, value }], paramId);
    });
  }

  async #getChannel(name: string) {
    await this.#connecting;
    return (
      this.#channelsByName.get(name) ??
      (await new Promise<Channel>((resolve) => {
        const listener = (channels: Channel[]) => {
          const channel = channels.find((channel) => channel.topic === name);
          if (channel) {
            this.#client.off('advertise', listener);
            resolve(channel);
          }
        };
        this.#client.on('advertise', listener);
      }))
    );
  }

  async #getService(name: string, timeoutMs?: number) {
    await this.#connecting;
    const service = this.#servicesByName.get(name);
    if (service) {
      return service;
    }
    return new Promise<Service>((resolve, reject) => {
      const listener = (services: Service[]) => {
        const service = services.find((service) => service.name === name);
        if (service) {
          this.#client.off('advertiseServices', listener);
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          resolve(service);
        }
      };
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#client.off('advertiseServices', listener);
              reject(
                new Error(
                  `Service "${name}" was not advertised within ${timeoutMs} ms`,
                ),
              );
            }, timeoutMs);
      this.#client.on('advertiseServices', listener);
    });
  }

  #getMessageReader(channelOrService: Channel | Service) {
    const { name, schemaEncoding, schema } =
      'topic' in channelOrService
        ? {
            name: channelOrService.schemaName,
            schemaEncoding: channelOrService.schemaEncoding,
            schema: channelOrService.schema,
          }
        : serviceSchema(channelOrService, 'response');
    if (schema === undefined) {
      throw new Error(`Missing schema for "${name}"`);
    }
    return (
      this.#messageReaders.get(name) ??
      (() => {
        const reader = this.#isRos1
          ? new Ros1MessageReader(parse(schema, { ros2: false }))
          : new Ros2MessageReader(
              schemaEncoding === 'ros2idl'
                ? parseRos2idl(schema)
                : parse(schema, { ros2: true }),
            );
        this.#messageReaders.set(name, reader);
        return reader;
      })()
    );
  }

  #getMessageWriter(channelOrService: Channel | Service) {
    const { name, schemaEncoding, schema } =
      'topic' in channelOrService
        ? {
            name: channelOrService.schemaName,
            schemaEncoding: channelOrService.schemaEncoding,
            schema: channelOrService.schema,
          }
        : serviceSchema(channelOrService, 'request');
    if (schema === undefined) {
      throw new Error(`Missing schema for "${name}"`);
    }
    return (
      this.#messageWriters.get(name) ??
      (() => {
        const writer = this.#isRos1
          ? new Ros1MessageWriter(parse(schema, { ros2: false }))
          : new Ros2MessageWriter(
              schemaEncoding === 'ros2idl'
                ? parseRos2idl(schema)
                : parse(schema, { ros2: true }),
            );
        this.#messageWriters.set(name, writer);
        return writer;
      })()
    );
  }
}
