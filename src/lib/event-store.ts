/* tslint:disable:variable-name */
//
// Modified version of this https://github.com/daypaio/nestjs-eventstore/blob/master/src/event-store/eventstore-cqrs/event-store.bus.ts
// special thanks to him.
//

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import {
  EventBus,
  IEvent,
  IEventPublisher,
  IMessageSource
} from '@nestjs/cqrs';
import { ExplorerService } from '@nestjs/cqrs/dist/services/explorer.service';
import * as Long from 'long';
import {
  createJsonEventData,
  EventData,
  EventStoreCatchUpSubscription,
  EventStorePersistentSubscription,
  EventStoreSubscription as EventStoreVolatileSubscription,
  expectedVersion,
  ResolvedEvent
} from 'node-eventstore-client';
import { Subject } from 'rxjs';
import { v4 } from 'uuid';
import { IEventStoreConnectConfig } from './contract/event-store-connect-config.interface';
import {
  EventStoreCatchupSubscription as ESCatchUpSubscription,
  EventStoreOptionConfig,
  EventStorePersistentSubscription as ESPersistentSubscription,
  EventStoreSubscriptionType,
  EventStoreVolatileSubscription as ESVolatileSubscription,
  ExtendedCatchUpSubscription,
  ExtendedPersistentSubscription,
  ExtendedVolatileSubscription,
  IEventConstructors
} from './contract/event-store-option.config';
import { ProvidersConstants } from './contract/nestjs-event-store.constant';
import { NestjsEventStore } from './nestjs-event-store.class';

/**
 * @class EventStore
 */
@Injectable()
export class EventStore
  implements IEventPublisher, OnModuleDestroy, OnModuleInit, IMessageSource {
  private logger = new Logger(this.constructor.name);
  private eventStore: NestjsEventStore;
  private eventHandlers: IEventConstructors;
  private subject$: Subject<IEvent>;
  private readonly featureStream?: string;
  private readonly subscriptionsDelay?: number;
  private catchupSubscriptions: ExtendedCatchUpSubscription[] = [];
  private catchupSubscriptionsCount: number;

  private persistentSubscriptions: ExtendedPersistentSubscription[] = [];
  private persistentSubscriptionsCount: number;

  private volatileSubscriptions: ExtendedVolatileSubscription[] = [];
  private volatileSubscriptionsCount: number;

  constructor(
    @Inject(ProvidersConstants.EVENT_STORE_PROVIDER) eventStore: any,
    @Inject(ProvidersConstants.EVENT_STORE_CONNECTION_CONFIG_PROVIDER)
    configService: IEventStoreConnectConfig,
    @Inject(ProvidersConstants.EVENT_STORE_STREAM_CONFIG_PROVIDER)
    esStreamConfig: EventStoreOptionConfig,
    private readonly explorerService: ExplorerService,
    private readonly eventsBus: EventBus
  ) {
    this.eventStore = eventStore;
    this.featureStream = esStreamConfig.featureStreamName;
    this.subscriptionsDelay = esStreamConfig.subscriptionsDelay;
    this.addEventHandlers(esStreamConfig.eventHandlers);
    this.eventStore.connect(configService.options, configService.tcpEndpoint);

    const catchupSubscriptions = esStreamConfig.subscriptions.filter(sub => {
      return sub.type === EventStoreSubscriptionType.CatchUp;
    });

    const persistentSubscriptions = esStreamConfig.subscriptions.filter(sub => {
      return sub.type === EventStoreSubscriptionType.Persistent;
    });

    const volatileSubscriptions = esStreamConfig.subscriptions.filter(sub => {
      return sub.type === EventStoreSubscriptionType.Volatile;
    });

    this.subscribeToCatchUpSubscriptions(
      catchupSubscriptions as ESCatchUpSubscription[]
    );

    this.subscribeToPersistentSubscriptions(
      persistentSubscriptions as ESPersistentSubscription[]
    );

    this.subscribeToVolatileSubscriptions(
      volatileSubscriptions as ESVolatileSubscription[]
    );
  }

  sleep(time: number) {
    return new Promise(r => setTimeout(r, time));
  }

  async publish(event: IEvent, stream?: string) {
    if (event === undefined) {
      return;
    }
    if (event === null) {
      return;
    }

    const eventPayload: EventData = createJsonEventData(
      v4(),
      event,
      null,
      stream
    );

    const streamId = stream ? stream : this.featureStream;

    try {
      await this.eventStore
        .getConnection()
        .appendToStream(streamId, expectedVersion.any, [eventPayload]);
    } catch (err) {
      this.logger.error(err);
    }
  }

  async subscribeToPersistentSubscriptions(
    subscriptions: ESPersistentSubscription[]
  ) {
    this.subscriptionsDelay && (await this.sleep(this.subscriptionsDelay));
    this.persistentSubscriptionsCount = subscriptions.length;
    this.persistentSubscriptions = await Promise.all(
      subscriptions.map(async subscription => {
        return await this.subscribeToPersistentSubscription(
          subscription.stream,
          subscription.persistentSubscriptionName
        );
      })
    );
  }

  async subscribeToCatchUpSubscriptions(
    subscriptions: ESCatchUpSubscription[]
  ) {
    this.subscriptionsDelay && (await this.sleep(this.subscriptionsDelay));
    this.catchupSubscriptionsCount = subscriptions.length;
    this.catchupSubscriptions = await Promise.all(
      subscriptions.map(subscription => {
        return this.subscribeToCatchupSubscription(
          subscription.stream,
          subscription.resolveLinkTos,
          subscription.lastCheckpoint
        );
      })
    );
  }

  async subscribeToVolatileSubscriptions(
    subscriptions: ESVolatileSubscription[]
  ) {
    this.subscriptionsDelay && (await this.sleep(this.subscriptionsDelay));
    this.volatileSubscriptionsCount = subscriptions.length;
    this.volatileSubscriptions = await Promise.all(
      subscriptions.map(async subscription => {
        return await this.subscribeToVolatileSubscription(
          subscription.stream,
          subscription.resolveLinkTos
        );
      })
    );
  }

  async subscribeToCatchupSubscription(
    stream: string,
    resolveLinkTos: boolean = true,
    lastCheckpoint: number | Long | null = 0
  ): Promise<ExtendedCatchUpSubscription> {
    this.logger.log(`Catching up and subscribing to stream ${stream}!`);
    try {
      return (await this.eventStore
        .getConnection()
        .subscribeToStreamFrom(
          stream,
          lastCheckpoint,
          resolveLinkTos,
          (sub, payload) => this.onEvent(sub, payload),
          subscription =>
            this.onLiveProcessingStarted(
              subscription as ExtendedCatchUpSubscription
            ),
          (sub, reason, error) =>
            this.onDropped(sub as ExtendedCatchUpSubscription, reason, error)
        )) as ExtendedCatchUpSubscription;
    } catch (err) {
      this.logger.error(err.message);
    }
  }

  async subscribeToVolatileSubscription(
    stream: string,
    resolveLinkTos: boolean = true
  ): Promise<ExtendedVolatileSubscription> {
    this.logger.log(`Volatile and subscribing to stream ${stream}!`);
    try {
      const resolved = (await this.eventStore
        .getConnection()
        .subscribeToStream(
          stream,
          resolveLinkTos,
          (sub, payload) => this.onEvent(sub, payload),
          (sub, reason, error) =>
            this.onDropped(sub as ExtendedVolatileSubscription, reason, error)
        )) as ExtendedVolatileSubscription;

      this.logger.log('Volatile processing of EventStore events started!');
      resolved.isLive = true;
      return resolved;
    } catch (err) {
      this.logger.error(err.message);
    }
  }

  get allCatchUpSubscriptionsLive(): boolean {
    const initialized =
      this.catchupSubscriptions.length === this.catchupSubscriptionsCount;
    return (
      initialized &&
      this.catchupSubscriptions.every(subscription => {
        return !!subscription && subscription.isLive;
      })
    );
  }

  get allVolatileSubscriptionsLive(): boolean {
    const initialized =
      this.volatileSubscriptions.length === this.volatileSubscriptionsCount;
    return (
      initialized &&
      this.volatileSubscriptions.every(subscription => {
        return !!subscription && subscription.isLive;
      })
    );
  }

  get allPersistentSubscriptionsLive(): boolean {
    const initialized =
      this.persistentSubscriptions.length === this.persistentSubscriptionsCount;
    return (
      initialized &&
      this.persistentSubscriptions.every(subscription => {
        return !!subscription && subscription.isLive;
      })
    );
  }

  async subscribeToPersistentSubscription(
    stream: string,
    subscriptionName: string
  ): Promise<ExtendedPersistentSubscription> {
    try {
      this.logger.log(`
       Connecting to persistent subscription ${subscriptionName} on stream ${stream}!
      `);

      const resolved = (await this.eventStore
        .getConnection()
        .connectToPersistentSubscription(
          stream,
          subscriptionName,
          (sub, payload) => this.onEvent(sub, payload),
          (sub, reason, error) =>
            this.onDropped(sub as ExtendedPersistentSubscription, reason, error)
        )) as ExtendedPersistentSubscription;

      resolved.isLive = true;

      return resolved;
    } catch (err) {
      this.logger.error(err.message);
    }
  }

  async onEvent(
    _subscription:
      | EventStorePersistentSubscription
      | EventStoreCatchUpSubscription
      | EventStoreVolatileSubscription,
    payload: ResolvedEvent
  ) {
    const { event } = payload;

    if (!event || !event.isJson) {
      this.logger.error('Received event that could not be resolved!');
      return;
    }

    const handler = this.eventHandlers[event.eventType];
    if (!handler) {
      this.logger.error('Received event that could not be handled!');
      return;
    }

    const rawData = JSON.parse(event.data.toString());
    const data = Object.values(rawData);

    const eventType = event.eventType || rawData.content.eventType;
    if (this.eventHandlers && this.eventHandlers[eventType]) {
      this.subject$.next(this.eventHandlers[event.eventType](...data));
    } else {
      Logger.warn(
        `Event of type ${eventType} not handled`,
        this.constructor.name
      );
    }
  }

  onDropped(
    subscription:
      | ExtendedPersistentSubscription
      | ExtendedCatchUpSubscription
      | ExtendedVolatileSubscription,
    _reason: string,
    error: Error
  ) {
    subscription.isLive = false;
    this.logger.error(error);
  }

  onLiveProcessingStarted(subscription: ExtendedCatchUpSubscription) {
    subscription.isLive = true;
    this.logger.log('Live processing of EventStore events started!');
  }

  get isLive(): boolean {
    return (
      this.allCatchUpSubscriptionsLive &&
      this.allPersistentSubscriptionsLive &&
      this.allVolatileSubscriptionsLive
    );
  }

  addEventHandlers(eventHandlers: IEventConstructors) {
    this.eventHandlers = { ...this.eventHandlers, ...eventHandlers };
  }
  onModuleInit(): any {
    this.subject$ = (this.eventsBus as any).subject$;
    this.bridgeEventsTo((this.eventsBus as any).subject$);
    this.eventsBus.publisher = this;
  }

  onModuleDestroy(): any {
    this.eventStore.close();
  }

  async bridgeEventsTo<T extends IEvent>(subject: Subject<T>): Promise<any> {
    this.subject$ = subject;
  }
}
