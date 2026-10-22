import { Controller, Get, Res } from '@nestjs/common';
import { metrics } from './metrics';

/**
 * GET /metrics — exposição Prometheus (seção 12), sem autenticação
 * (público-interno, igual aos health checks).
 */
@Controller()
export class MetricsController {
  @Get('metrics')
  async metrics(@Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown }): Promise<string> {
    res.setHeader('Content-Type', metrics.registry.contentType);
    return metrics.registry.metrics();
  }
}
