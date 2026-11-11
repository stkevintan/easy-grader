import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ThrottleBucket } from '../common/throttler.guard';
import { AuthUser, CurrentUnit, CurrentUser, UnitAccess, UnitContext } from '../common/auth.guard';
import { ConfirmDto, FindTaskQuery, JudgeDto, ListQuery, SUBJECTS, UpsertTaskDto } from './judge.dto';
import { JudgeService } from './judge.service';


@UnitAccess(['viewer', 'grader', 'manager', 'owner'])
@Controller('api')
export class JudgeController {
  constructor(private readonly judge: JudgeService) {}

  @Get('meta')
  meta() {
    return { subjects: SUBJECTS, scoreSteps: [0.5, 1, 2, 5] };
  }

  /** 扩展打开一道题时，用 平台+考试+题号 找上次的配置（断点续阅） */
  @Get('tasks/lookup')
  async lookup(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Query() q: FindTaskQuery) {
    if (q.unitId !== undefined && q.unitId !== unit.id) throw new BadRequestException('管理单元不一致');
    return { task: await this.judge.findTask(u.id, unit.id, q.platformHost, q.examTitle, q.questionNo) };
  }

  @Get('tasks')
  list(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext) {
    return this.judge.listTasks(u.id, unit.id);
  }

  @UnitAccess(['grader', 'manager', 'owner'])
  @Put('tasks')
  upsert(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Body() dto: UpsertTaskDto) {
    if (dto.unitId !== undefined && dto.unitId !== unit.id) throw new BadRequestException('管理单元不一致');
    return this.judge.upsertTask(u.id, unit.id, dto);
  }

  @Get('tasks/:id')
  get(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Param('id', ParseIntPipe) id: number) {
    return this.judge.getTask(u.id, unit.id, id);
  }

  @UnitAccess(['grader', 'manager', 'owner'])
  @Delete('tasks/:id')
  remove(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Param('id', ParseIntPipe) id: number) {
    return this.judge.deleteTask(u.id, unit.id, id);
  }

  @UnitAccess(['grader', 'manager', 'owner'])
  @ThrottleBucket('judge')
  @HttpCode(200)
  @Post('judge')
  run(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Body() dto: JudgeDto) {
    if (dto.unitId !== undefined && dto.unitId !== unit.id) throw new BadRequestException('管理单元不一致');
    return this.judge.judge(u.id, unit.id, dto.taskId, dto.image, dto.force);
  }

  @UnitAccess(['grader', 'manager', 'owner'])
  @HttpCode(200)
  @Post('records/:id/confirm')
  confirm(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Param('id', ParseIntPipe) id: number, @Body() dto: ConfirmDto) {
    return this.judge.confirm(u.id, unit.id, id, dto.finalScore, dto.autoSubmitted);
  }

  @Get('records')
  records(@CurrentUser() u: AuthUser, @CurrentUnit() unit: UnitContext, @Query() q: ListQuery) {
    return this.judge.listRecords(u.id, unit.id, q.taskId, q.page, q.pageSize);
  }
}
