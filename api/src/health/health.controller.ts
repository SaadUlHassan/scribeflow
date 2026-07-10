import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../auth/public.decorator';
import { PublisherService } from '../queue/publisher.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly publisher: PublisherService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness/readiness probe (no auth)' })
  async check(): Promise<{ status: string }> {
    const database = await this.dataSource
      .query('SELECT 1')
      .then(() => 'up')
      .catch(() => 'down');
    const broker = this.publisher.isConnected ? 'up' : 'down';

    if (database !== 'up' || broker !== 'up') {
      throw new ServiceUnavailableException({
        status: 'error',
        database,
        broker,
      });
    }
    return { status: 'ok' };
  }
}
