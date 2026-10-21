import type { IntegrationEvent } from '../../domain/integration-event';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/**
 * Porta de publicação de eventos — implementação SQS na ET12
 * (wagering-events.fifo, MessageDeduplicationId = eventId).
 */
export interface EventPublisherPort {
  publish(event: IntegrationEvent<unknown>): Promise<void>;
}
