import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AdapterConfig } from './adapters/adapter-config';
import type { ExamInfo, MajorInput, QuestionInfo } from './judge/task-info';

export type Role = 'user' | 'admin';
export type UnitRole = 'owner' | 'manager' | 'grader' | 'viewer';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn() id!: number;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 32 }) username!: string;
  @Column({ type: 'varchar' }) passwordHash!: string;
  @Column({ type: 'varchar', default: 'user' }) role!: Role;
  @Column({ type: 'integer', default: 0 }) credits!: number;
  @Column({ type: 'boolean', default: false }) disabled!: boolean;
  /** 改密码/禁用时 +1，使旧 JWT 失效 */
  @Column({ type: 'integer', default: 0 }) tokenVersion!: number;
  @CreateDateColumn() createdAt!: Date;
  @Column({ type: 'datetime', nullable: true }) lastLoginAt!: Date | null;
}

/** 组织/管理单元；数据默认按 unitId 隔离 */
@Entity('management_units')
@Index(['name'], { unique: true })
export class ManagementUnit {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'varchar', length: 100 }) name!: string;
  @Column({ type: 'varchar', default: '' }) description!: string;
  @Column({ type: 'integer' }) ownerId!: number;
  @Column({ type: 'boolean', default: true }) enabled!: boolean;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('unit_memberships')
@Index(['unitId', 'userId'], { unique: true })
export class UnitMembership {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'integer' }) unitId!: number;
  @Column({ type: 'integer' }) userId!: number;
  @Column({ type: 'varchar', default: 'grader' }) role!: UnitRole;
  @CreateDateColumn() createdAt!: Date;
}

export type LedgerReason = 'register' | 'redeem' | 'judge' | 'refund' | 'admin';

@Entity('credit_ledger')
@Index(['userId', 'createdAt'])
export class CreditLedger {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'integer' }) userId!: number;
  @Column({ type: 'integer' }) delta!: number;
  @Column({ type: 'integer' }) balanceAfter!: number;
  @Column({ type: 'varchar' }) reason!: LedgerReason;
  @Column({ type: 'integer', nullable: true }) refId!: number | null;
  @Column({ type: 'varchar', default: '' }) note!: string;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('redeem_codes')
export class RedeemCode {
  @PrimaryGeneratedColumn() id!: number;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 32 }) code!: string;
  @Column({ type: 'integer' }) credits!: number;
  @Column({ type: 'integer', default: 1 }) maxUses!: number;
  @Column({ type: 'integer', default: 0 }) usedCount!: number;
  @Column({ type: 'datetime', nullable: true }) expiresAt!: Date | null;
  @Column({ type: 'boolean', default: false }) disabled!: boolean;
  @Column({ type: 'varchar', default: '' }) note!: string;
  @Column({ type: 'integer', nullable: true }) createdBy!: number | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('invite_tokens')
@Index(['tokenHash'], { unique: true })
export class InviteToken {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'varchar', length: 64 }) tokenHash!: string;
  @Column({ type: 'integer' }) unitId!: number;
  @Column({ type: 'integer', default: 0 }) credits!: number;
  @Column({ type: 'integer', default: 10 }) maxUses!: number;
  @Column({ type: 'integer', default: 0 }) usedCount!: number;
  @Column({ type: 'datetime', nullable: true }) expiresAt!: Date | null;
  @Column({ type: 'boolean', default: false }) disabled!: boolean;
  @Column({ type: 'varchar', default: '' }) note!: string;
  @Column({ type: 'integer', nullable: true }) createdBy!: number | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('redeem_uses')
@Index(['codeId', 'userId'], { unique: true })
export class RedeemUse {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'integer' }) codeId!: number;
  @Column({ type: 'integer' }) userId!: number;
  @CreateDateColumn() createdAt!: Date;
}

/** 一道题的阅卷任务：题目、参考答案、评分标准 */
@Entity('tasks')
@Index(['userId', 'platformHost', 'examTitle', 'questionNo'])
export class GradingTask {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'integer' }) userId!: number;
  @Column({ type: 'varchar', default: '' }) platformHost!: string;
  /** 服务端签发的评分标识，对应原版 createTask 返回的 judge_id */
  @Index({ unique: true }) @Column({ type: 'varchar', length: 40, nullable: true }) judgeId!: string | null;
  /** 原版 taskInfo.exam；旧数据为 null，由 TaskInfoService 在启动时回填 */
  @Column({ type: 'simple-json', nullable: true }) exam!: ExamInfo | null;
  /** 原版 taskInfo.question */
  @Column({ type: 'simple-json', nullable: true }) question!: QuestionInfo | null;
  /** 原版 taskInfo.majorInput */
  @Column({ type: 'simple-json', nullable: true }) majorInput!: MajorInput | null;
  /** 以下扁平列是索引和模型提示词用的冗余，JSON 列是任务结构的来源 */
  @Column({ type: 'varchar', default: '' }) examTitle!: string;
  @Column({ type: 'varchar', default: '' }) questionNo!: string;
  @Column({ type: 'varchar', default: '语文' }) subject!: string;
  @Column({ type: 'varchar', default: '' }) questionType!: string;
  @Column({ type: 'real' }) maxScore!: number;
  @Column({ type: 'real', default: 1 }) scoreStep!: number;
  @Column({ type: 'text', default: '' }) questionText!: string;
  @Column({ type: 'text', default: '' }) referenceAnswer!: string;
  @Column({ type: 'text', default: '' }) rubric!: string;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

export type RecordStatus = 'done' | 'failed';

/** 一份答卷的评分记录；不保存答卷图片，只存 sha256 */
@Entity('judge_records')
@Index(['userId', 'taskId', 'imageSha256'])
@Index(['createdAt'])
export class JudgeRecord {
  @PrimaryGeneratedColumn() id!: number;
  /** 对外暴露的评分标识，对应原版 judge 返回的 grading_id */
  @Index({ unique: true }) @Column({ type: 'varchar', length: 40, nullable: true }) gradingId!: string | null;
  @Column({ type: 'integer' }) userId!: number;
  @Column({ type: 'integer' }) taskId!: number;
  @Column({ type: 'varchar', length: 64 }) imageSha256!: string;
  @Column({ type: 'varchar' }) status!: RecordStatus;
  @Column({ type: 'real', nullable: true }) aiScore!: number | null;
  @Column({ type: 'real', nullable: true }) confidence!: number | null;
  @Column({ type: 'simple-json', nullable: true }) reasons!: string[] | null;
  @Column({ type: 'text', default: '' }) comment!: string;
  @Column({ type: 'text', default: '' }) ocrText!: string;
  @Column({ type: 'real', nullable: true }) finalScore!: number | null;
  @Column({ type: 'boolean', default: false }) autoSubmitted!: boolean;
  @Column({ type: 'boolean', default: false }) charged!: boolean;
  @Column({ type: 'varchar', default: '' }) model!: string;
  /** 评分时用的模型方案（功能开关 model_profile），用于比较不同方案的效果 */
  @Column({ type: 'varchar', default: 'default' }) modelProfile!: string;
  @Column({ type: 'integer', default: 0 }) latencyMs!: number;
  @Column({ type: 'text', default: '' }) error!: string;
  @CreateDateColumn() createdAt!: Date;
  @Column({ type: 'datetime', nullable: true }) confirmedAt!: Date | null;
}

export type PresetScope = 'public' | 'private';

/** 平台适配预设：按 host（+可选路径片段）匹配，内容是选择器配置 */
@Entity('adapter_presets')
@Index(['hostPattern'])
export class AdapterPreset {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'varchar' }) name!: string;
  /** 精确 host 或主域，如 xiaoxianai.cn 会匹配 www.xiaoxianai.cn */
  @Column({ type: 'varchar' }) hostPattern!: string;
  /** 可选：路径包含的片段 */
  @Column({ type: 'varchar', default: '' }) pathPattern!: string;
  @Column({ type: 'simple-json' }) config!: AdapterConfig;
  @Column({ type: 'varchar', default: 'private' }) scope!: PresetScope;
  @Column({ type: 'integer', nullable: true }) ownerId!: number | null;
  @Column({ type: 'boolean', default: true }) enabled!: boolean;
  @Column({ type: 'varchar', default: '' }) note!: string;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

/**
 * 功能开关的取值覆盖。开关本身在代码里定义（flags/flag-definitions.ts），这里只存改过的值。
 *   global  全局取值，替代代码里的默认值（targetId=0）
 *   rollout 百分比放量：按 key+userId 哈希落在 percent 以内的用户取 value（targetId=0）
 *   unit    某个管理单元（targetId=unitId）
 *   user    某个用户（targetId=userId）
 * 取值优先级：user > unit > rollout > global > 代码默认值
 */
export type FlagScope = 'global' | 'rollout' | 'unit' | 'user';
export type FlagSnapshot = { value: boolean | number | string; percent: number | null };

@Entity('feature_flag_overrides')
@Index(['flagKey', 'scope', 'targetId'], { unique: true })
export class FeatureFlagOverride {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'varchar', length: 64 }) flagKey!: string;
  @Column({ type: 'varchar' }) scope!: FlagScope;
  /** unit / user 时是对应 id；global / rollout 为 0（SQLite 唯一索引里 NULL 互不相等，所以不用 NULL） */
  @Column({ type: 'integer', default: 0 }) targetId!: number;
  @Column({ type: 'simple-json' }) value!: boolean | number | string;
  /** 仅 rollout：0-100 */
  @Column({ type: 'integer', nullable: true }) percent!: number | null;
  @Column({ type: 'integer', nullable: true }) updatedBy!: number | null;
  @UpdateDateColumn() updatedAt!: Date;
}

/** 功能开关修改记录：谁、什么时候、从什么值改成什么值 */
@Entity('feature_flag_audit')
@Index(['flagKey', 'createdAt'])
export class FeatureFlagAudit {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: 'varchar', length: 64 }) flagKey!: string;
  @Column({ type: 'varchar' }) scope!: FlagScope;
  @Column({ type: 'integer', default: 0 }) targetId!: number;
  /** 修改前后的取值；null 表示没有覆盖 */
  @Column({ type: 'simple-json', nullable: true }) before!: FlagSnapshot | null;
  @Column({ type: 'simple-json', nullable: true }) after!: FlagSnapshot | null;
  @Column({ type: 'integer' }) actorId!: number;
  @Column({ type: 'varchar', default: '' }) actorName!: string;
  @CreateDateColumn() createdAt!: Date;
}

export const ENTITIES = [
  User,
  CreditLedger,
  RedeemCode,
  RedeemUse,
  InviteToken,
  GradingTask,
  JudgeRecord,
  AdapterPreset,
  ManagementUnit,
  UnitMembership,
  FeatureFlagOverride,
  FeatureFlagAudit,
];
