import { Global, Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { mikroOrmConfig } from './mikro-orm.config';

export const MIKRO_ORM = Symbol('MIKRO_ORM');

/**
 * Módulo global do MikroORM (ADR-001).
 */
@Global()
@Module({
  providers: [
    {
      provide: MIKRO_ORM,
      useFactory: async () => MikroORM.init(mikroOrmConfig),
    },
  ],
  exports: [MIKRO_ORM],
})
export class DatabaseModule {}
