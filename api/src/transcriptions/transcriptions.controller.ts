import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CreatedJobDto,
  JobDetailDto,
  JobSummaryDto,
  toJobDetail,
  toJobSummary,
} from './dto/job-response.dto';
import { ExportQueryDto } from './dto/export-query.dto';
import { ListQueryDto } from './dto/list-query.dto';
import { toSrt, toVtt } from './srt.util';
import { TranscriptionsService } from './transcriptions.service';

@ApiTags('transcriptions')
@ApiSecurity('api-key')
@Controller('transcriptions')
export class TranscriptionsController {
  constructor(private readonly transcriptions: TranscriptionsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload an audio file for transcription' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 202, type: CreatedJobDto, description: 'Job queued' })
  @ApiResponse({
    status: 200,
    type: CreatedJobDto,
    description: 'Duplicate of an already-completed job',
  })
  async create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreatedJobDto> {
    if (!file) {
      throw new BadRequestException('Multipart field "file" is required');
    }
    const { job, deduplicated } = await this.transcriptions.create(file);
    res.status(deduplicated ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return { id: job.id, status: job.status };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Job status; transcript included when completed' })
  @ApiResponse({ status: 200, type: JobDetailDto })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<JobDetailDto> {
    return toJobDetail(await this.transcriptions.findById(id));
  }

  @Get(':id/export')
  @ApiOperation({ summary: 'Export the transcript as SRT (default) or VTT' })
  @ApiResponse({ status: 200, description: 'Subtitle file' })
  @ApiResponse({ status: 409, description: 'Job is not completed yet' })
  async export(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ExportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const job = await this.transcriptions.findById(id);
    if (job.status !== 'completed' || !job.transcript) {
      throw new ConflictException(
        `Job is ${job.status}; export requires a completed transcription`,
      );
    }
    const segments = job.transcript.segments;
    res.set({
      'Content-Type':
        query.format === 'vtt'
          ? 'text/vtt; charset=utf-8'
          : 'application/x-subrip; charset=utf-8',
      'Content-Disposition': `attachment; filename="${job.id}.${query.format}"`,
    });
    return query.format === 'vtt' ? toVtt(segments) : toSrt(segments);
  }

  @Get()
  @ApiOperation({ summary: 'List jobs, newest first (transcripts omitted)' })
  @ApiResponse({ status: 200, type: [JobSummaryDto] })
  async list(@Query() query: ListQueryDto): Promise<JobSummaryDto[]> {
    const jobs = await this.transcriptions.list(query.limit, query.offset);
    return jobs.map(toJobSummary);
  }
}
