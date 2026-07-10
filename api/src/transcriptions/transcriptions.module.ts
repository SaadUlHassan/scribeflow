import { Module, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { diskStorage } from 'multer';
import { EnvironmentVariables } from '../config/env.validation';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { uploadTempDir } from '../storage/storage.service';
import { validateUpload } from '../storage/upload-validation';
import { Job } from './entities/job.entity';
import { TranscriptionsController } from './transcriptions.controller';
import { TranscriptionsService } from './transcriptions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job]),
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        storage: diskStorage({
          destination: uploadTempDir(config.get('AUDIO_DIR', { infer: true })),
          filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
        }),
        limits: {
          fileSize: config.get('MAX_UPLOAD_MB', { infer: true }) * 1024 * 1024,
        },
        // Reject invalid uploads before any bytes hit disk; the service
        // re-checks as defense in depth.
        fileFilter: (_req, file, cb) => {
          const rejection = validateUpload(file.originalname, file.mimetype);
          if (rejection) {
            cb(new UnsupportedMediaTypeException(rejection.reason), false);
          } else {
            cb(null, true);
          }
        },
      }),
    }),
    StorageModule,
    QueueModule,
  ],
  controllers: [TranscriptionsController],
  providers: [TranscriptionsService],
})
export class TranscriptionsModule {}
