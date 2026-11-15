import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CLIENT_VERSION_HEADER, FlagService } from '../flags/flag.service';
import { ThrottleBucket } from '../common/throttler.guard';
import { AuthUser, CurrentUser } from '../common/auth.guard';
import { ConfirmDto, FindTaskQuery, JudgeDto, ListQuery, SUBJECTS, UpsertTaskDto } from './judge.dto';
import { JudgeService } from './judge.service';


@Controller('api')
export class JudgeController {
  constructor(
    private readonly judge: JudgeService,
    private readonly flags: FlagService,
  ) {}

  @Get('meta')
  meta() {
    return { subjects: SUBJECTS, scoreSteps: [0.5, 1, 2, 5] };
  }

  /** 扩展打开一道题时，用 平台+考试+题号 找上次的配置（断点续阅） */
  @Get('tasks/lookup')
  async lookup(@CurrentUser() u: AuthUser, @Query() q: FindTaskQuery) {
    return { task: await this.judge.findTask(u.id, q.platformHost, q.exam, q.q_index) };
  }

  @Get('tasks')
  list(@CurrentUser() u: AuthUser) {
    return this.judge.listTasks(u.id);
  }

  @Put('tasks')
  upsert(@CurrentUser() u: AuthUser, @Body() dto: UpsertTaskDto) {
    return this.judge.upsertTask(u.id, dto);
  }

  @Get('tasks/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.judge.getTask(u.id, id);
  }

  @Delete('tasks/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.judge.deleteTask(u.id, id);
  }

  @ThrottleBucket('judge')
  @HttpCode(200)
  @Post('judge')
  async run(@CurrentUser() u: AuthUser, @Body() dto: JudgeDto, @Req() req: Request) {
    await this.flags.assertClientVersion(u.id, req.headers[CLIENT_VERSION_HEADER]);
    return this.judge.judge(u.id, dto.taskId, dto.image, dto.force);
  }

  @HttpCode(200)
  @Post('records/:id/confirm')
  async confirm(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ConfirmDto, @Req() req: Request) {
    await this.flags.assertClientVersion(u.id, req.headers[CLIENT_VERSION_HEADER]);
    return this.judge.confirm(u.id, id, dto.modifiedScore, dto.isAuto ?? false);
  }

  @Get('records')
  records(@CurrentUser() u: AuthUser, @Query() q: ListQuery) {
    return this.judge.listRecords(u.id, q.taskId, q.page, q.pageSize);
  }

  /** 控制台用：单条评分记录详情（含 OCR 文本），只能看自己的 */
  @Get('records/:gradingId')
  async recordDetail(@CurrentUser() u: AuthUser, @Param('gradingId') gradingId: string) {
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(gradingId)) throw new BadRequestException('评分记录不存在');
    const detail = await this.judge.recordDetail(u.id, gradingId);
    if (!detail) throw new NotFoundException('评分记录不存在');
    return detail;
  }

  /** 控制台首页用：个人近 N 天的评分量和总体偏差 */
  @Get('me/stats')
  myStats(@CurrentUser() u: AuthUser, @Query('days') days?: string) {
    const n = days === undefined ? 30 : Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 180) throw new BadRequestException('days 必须是 1 到 180 的整数');
    return this.judge.myStats(u.id, n);
  }
}
