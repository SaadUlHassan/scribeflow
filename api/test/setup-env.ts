// Runs before test modules are imported; ConfigModule validates env at import time.
process.env.API_KEY = 'test-key';
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.RABBITMQ_URL = 'amqp://test:test@localhost:5672/';
