/**
 * Porta de geração de IDs (ADR-008: UUIDv7).
 * Injetável para determinismo nos testes.
 */
export const ID_GENERATOR = Symbol('ID_GENERATOR');

export interface IdGeneratorPort {
  newId(): string;
}
