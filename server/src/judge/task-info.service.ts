import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { GradingTask, JudgeRecord } from '../entities';
import { toTaskInfo } from './task-info';

/**
 * 启动时给旧数据补上 judgeId / gradingId，并把扁平的题目字段回填成
 * exam / question / majorInput 结构。字段全部可空、只增不删，重复执行安全。
 */
@Injectable()
export class TaskInfoService implements OnModuleInit {
  private readonly log = new Logger('TaskInfo');

  constructor(
    @InjectRepository(GradingTask) private readonly tasks: Repository<GradingTask>,
    @InjectRepository(JudgeRecord) private readonly records: Repository<JudgeRecord>,
  ) {}

  async onModuleInit() {
    await this.tasks.query(
      "UPDATE tasks SET judgeId = 'j_' || lower(hex(randomblob(16))) WHERE judgeId IS NULL OR judgeId = ''",
    );
    await this.records.query(
      "UPDATE judge_records SET gradingId = 'g_' || lower(hex(randomblob(16))) WHERE gradingId IS NULL OR gradingId = ''",
    );

    const legacy = await this.tasks.find({ where: { exam: IsNull() } });
    for (const t of legacy) {
      const info = toTaskInfo(t);
      await this.tasks.update(t.id, {
        exam: info.exam,
        question: info.question,
        majorInput: info.majorInput,
      });
    }
    if (legacy.length) this.log.log(`已回填 ${legacy.length} 条任务的题目结构`);
  }
}
