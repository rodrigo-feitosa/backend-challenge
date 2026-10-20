/**
 * Porta de relógio — determinismo nos testes e substituibilidade.
 */
export const CLOCK = Symbol('CLOCK');

export interface ClockPort {
  now(): Date;
}
