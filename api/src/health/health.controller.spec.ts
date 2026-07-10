import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { PublisherService } from '../queue/publisher.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const dataSource = { query: jest.fn() };
  const publisher = { isConnected: true };
  let controller: HealthController;

  beforeEach(async () => {
    jest.resetAllMocks();
    publisher.isConnected = true;
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: PublisherService, useValue: publisher },
      ],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('returns ok when database and broker are up', async () => {
    dataSource.query.mockResolvedValue([{ '?column?': 1 }]);
    await expect(controller.check()).resolves.toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is down', async () => {
    dataSource.query.mockRejectedValue(new Error('connection refused'));
    await expect(controller.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('returns 503 when the broker is down', async () => {
    dataSource.query.mockResolvedValue([{ '?column?': 1 }]);
    publisher.isConnected = false;
    await expect(controller.check()).rejects.toMatchObject({
      response: { status: 'error', database: 'up', broker: 'down' },
    });
  });
});
