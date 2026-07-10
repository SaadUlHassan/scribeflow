import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { SubtitleFormat } from '../srt.util';

export class ExportQueryDto {
  @ApiPropertyOptional({ enum: ['srt', 'vtt'], default: 'srt' })
  @IsOptional()
  @IsIn(['srt', 'vtt'])
  format: SubtitleFormat = 'srt';
}
