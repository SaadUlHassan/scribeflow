import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard';

const API_KEY = 'correct-key';

function contextWithHeader(key?: string): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        header: (name: string) =>
          name.toLowerCase() === 'x-api-key' ? key : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  const config = { get: jest.fn().mockReturnValue(API_KEY) };
  const reflector = { getAllAndOverride: jest.fn() };
  let guard: ApiKeyGuard;

  beforeEach(() => {
    reflector.getAllAndOverride.mockReturnValue(false);
    guard = new ApiKeyGuard(
      config as unknown as ConfigService,
      reflector as unknown as Reflector,
    );
  });

  it('rejects requests without a key', () => {
    expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects requests with a wrong key', () => {
    expect(() => guard.canActivate(contextWithHeader('wrong-key'))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts requests with the configured key', () => {
    expect(guard.canActivate(contextWithHeader(API_KEY))).toBe(true);
  });

  it('skips public routes', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    expect(guard.canActivate(contextWithHeader(undefined))).toBe(true);
  });
});
