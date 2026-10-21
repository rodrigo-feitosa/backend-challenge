import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { MikroORM } from '@mikro-orm/core';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MIKRO_ORM } from '../shared/infrastructure/database/database.module';
import { SQS_CLIENT, getSqsQueueUrls } from '../messaging/infrastructure/sqs/sqs.module';

/**
 * Endpoints de saúde (seções 9 e 12 do desafio) — sem autenticação.
 *
 * GET /health/live — liveness: o processo está vivo se este handler executa.
 * GET /health/ready — readiness: PostgreSQL e SQS alcançáveis; 200 só quando
 *   o serviço pode processar tráfego, 503 quando uma dependência está fora.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly healthIndicator: HealthIndicatorService,
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  @Get('live')
  live(): { status: 'ok'; info: { process: { status: 'up' } } } {
    return { status: 'ok', info: { process: { status: 'up' } } };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<{ status: string; details: Record<string, unknown> }> {
    return this.healthCheckService.check([() => this.checkPg(), () => this.checkSqs()]);
  }

  private checkPg(): PromiseLike<HealthIndicatorResult> {
    return this.healthIndicator
      .check('postgres')
      .attempt(async () => {
        await this.orm.em.getConnection().execute('SELECT 1');
      })
      .withTimeout(3000);
  }

  private async checkSqs(): Promise<HealthIndicatorResult> {
    const session = this.healthIndicator.check('sqs');
    if (!getSqsQueueUrls().transactions) {
      return session.down({ message: 'SQS_QUEUE_TRANSACTIONS_URL not configured' });
    }
    try {
      await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: getSqsQueueUrls().transactions, AttributeNames: ['QueueArn'] }),
      );
      return session.up();
    } catch (err) {
      return session.down({ message: err instanceof Error ? err.message : 'unreachable' });
    }
  }
}
