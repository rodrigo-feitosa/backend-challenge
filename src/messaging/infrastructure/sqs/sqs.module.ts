import { Global, Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

/**
 * URLs das filas lidas no momento da chamada (não no import do módulo) —
 * permite que testes apontem para o LocalStack da suíte.
 */
export function getSqsQueueUrls(): { transactions: string; dlq: string; events: string } {
  return {
    transactions: process.env.SQS_QUEUE_TRANSACTIONS_URL ?? '',
    dlq: process.env.SQS_QUEUE_DLQ_URL ?? '',
    events: process.env.SQS_QUEUE_EVENTS_URL ?? '',
  };
}

/**
 * Módulo global do cliente SQS (ADR-001).
 * As filas são externas à aplicação (init script / LocalStack / init.sh);
 * o readiness as verifica, mas a aplicação sobe mesmo sem SQS.
 */
@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: () =>
        new SQSClient({
          endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
          region: process.env.AWS_REGION ?? 'us-east-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }),
    },
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule {}
