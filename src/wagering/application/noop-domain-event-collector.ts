import type { DomainEventCollector, WageringDomainEvent } from './domain-events';

/**
 * Implementação padrão do coletor de eventos: coleta e descarta.
 * Substituída na ET10 pelo gravador da transactional outbox.
 */
export class NoopDomainEventCollector implements DomainEventCollector {
  collect(_event: WageringDomainEvent): void {}
}
