import { type LoggerService } from '@nestjs/common';
import { pino, type DestinationStream } from 'pino';
import { correlationBindings } from './correlation';

/**
 * Logger estruturado JSON (requisito da seção 12 do desafio).
 * Os bindings de correlação (correlationId, messageId, transactionId,
 * walletId, providerId) são injetados automaticamente em TODA linha de log
 * via mixin + AsyncLocalStorage — nenhum código de domínio precisa propagar.
 */
export function buildLogger(destination?: DestinationStream) {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { service: 'wagering-processor' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      mixin: (mergeContext) => {
        const bindings = correlationBindings();
        return bindings ? { ...bindings, ...mergeContext } : mergeContext;
      },
    },
    destination,
  );
}

export const rootLogger = buildLogger();

export function createLogger(scope: string) {
  return rootLogger.child({ scope });
}

/**
 * Adaptador pino → NestJS LoggerService (para o logger interno do Nest).
 */
export class PinoNestLogger implements LoggerService {
  private readonly logger = createLogger('nest');

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    if (isErrorLike(message)) {
      this.logger.error({ err: message, context, trace }, message.message);
      return;
    }
    this.logger.error({ context, trace }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('trace', message, context);
  }

  private write(level: 'info' | 'warn' | 'error' | 'debug' | 'trace', message: unknown, context?: string): void {
    this.logger[level]({ context }, isErrorLike(message) ? message.message : String(message));
  }
}

function isErrorLike(value: unknown): value is { message: string } {
  return typeof value === 'object' && value !== null && 'message' in value && typeof (value as { message: unknown }).message === 'string';
}
