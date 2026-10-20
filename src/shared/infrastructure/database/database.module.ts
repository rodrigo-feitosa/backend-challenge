import { Global, Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { runMigrations } from './migration-runner';
import { getMikroOrmConfig } from './mikro-orm.config';

export const MIKRO_ORM = Symbol('MIKRO_ORM');
export const ENTITY_MANAGER = Symbol('ENTITY_MANAGER');

/**
 * Módulo global do MikroORM (ADR-001).
 * Executa migrations no bootstrap (opcional: MIGRATIONS_ON_START=false)
 * e fornece o EntityManager global (forks são criados por transação nos
 * use cases — cada transação SQL tem seu próprio em).
 */
@Global()
@Module({
  providers: [
    {
      provide: MIKRO_ORM,
      useFactory: async () => {
        const orm = await MikroORM.init(getMikroOrmConfig());
        if (process.env.MIGRATIONS_ON_START !== 'false') {
          await runMigrations(orm, { optional: true });
        }
        return orm;
      },
    },
    {
      provide: ENTITY_MANAGER,
      useFactory: (orm: MikroORM) => orm.em.fork(),
      inject: [MIKRO_ORM],
    },
  ],
  exports: [MIKRO_ORM, ENTITY_MANAGER],
})
export class DatabaseModule {}
