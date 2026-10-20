import { Global, Module } from '@nestjs/common';
import { CLOCK } from './application/ports/clock-port';
import { ID_GENERATOR } from './application/ports/id-generator-port';
import { SystemClock, UuidV7Generator } from './infrastructure/id-clock.providers';

/**
 * Módulo global de portas básicas compartilhadas (ADR-008).
 */
@Global()
@Module({
  providers: [
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: CLOCK, useClass: SystemClock },
  ],
  exports: [ID_GENERATOR, CLOCK],
})
export class SharedModule {}
