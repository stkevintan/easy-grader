import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AdapterConfig } from './adapters/adapter-config';

export type Role = 'user' | 'admin';

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

export const ENTITIES = [
  User,
  CreditLedger,
  RedeemCode,
  RedeemUse,
  GradingTask,
  JudgeRecord,
  AdapterPreset,
];
