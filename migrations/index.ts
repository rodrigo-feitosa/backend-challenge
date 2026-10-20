import { type MigrationObject } from '@mikro-orm/core';
import { Migration20260801000000 } from './Migration20260801000000';

/**
 * Lista explícita de migrations — determinística em qualquer runtime
 * (sem varredura de filesystem) e ordem garantida.
 * Novas migrations: criar a classe em migrations/ e adicioná-la aqui.
 */
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20260801000000', class: Migration20260801000000 },
];
