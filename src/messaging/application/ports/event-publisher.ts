import type { OutboxMessage } from '../../domain/outbox-message';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/**
 * Porta de publicação de eventos — implementação SQS (wagering-events.fifo,
 * MessageDeduplicationId = eventId). Recebe a mensagem da outbox já
 * reivindicada; o payload é o envelope JSON do evento.
 */
export interface EventPublisherPort {
  publish(message: OutboxMessage): Promise<void>;
}
