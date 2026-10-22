import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';

/**
 * Módulo de métricas: apenas o endpoint /metrics — o registro em si é um
 * singleton de processo (metrics.ts), acessado diretamente pelos pontos
 * de instrumentação.
 */
@Module({
  controllers: [MetricsController],
})
export class MetricsModule {}
