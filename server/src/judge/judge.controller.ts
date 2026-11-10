import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ThrottleBucket } from '../common/throttler.guard';
import { AuthUser, CurrentUser } from '../common/auth.guard';
import { ConfirmDto, FindTaskQuery, JudgeDto, ListQuery, SUBJECTS, UpsertTaskDto } from './judge.dto';
import { JudgeService } from './judge.service';


@Controller('api')
export class JudgeController {
  constructor(private readonly judge: JudgeService) {}

  @Get('meta')
  meta() {
    return { subjects: SUBJECTS, scoreSteps: [0.5, 1, 2, 5] };
  }

  /** 扩展打开一道题时，用 平台+考试+题号 找上次的配置（断点续阅） */
  @Get('tasks/lookup')
  async lookup(@CurrentUser() u: AuthUser, @Query() q: FindTaskQuery) {
    return { task: await this.judge.findTask(u.id, q.platformHost, q.examTitle, q.questionNo) };
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
  run(@CurrentUser() u: AuthUser, @Body() dto: JudgeDto) {
    return this.judge.judge(u.id, dto.taskId, dto.image, dto.force);
  }

  @HttpCode(200)
  @Post('records/:id/confirm')
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConfirmDto) {
    return this.judge.confirm(u.id, id, dto.finalScore, dto.autoSubmitted);
  }

  @Get('records')
  records(@CurrentUser() u: AuthUser, @Query() q: ListQuery) {
    return this.judge.listRecords(u.id, q.taskId, q.page, q.pageSize);
  }
}
