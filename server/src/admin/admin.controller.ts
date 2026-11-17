import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { DataSource, In, Repository } from 'typeorm';
import type { AdapterConfig } from '../adapters/adapter-config';
import { APP_CONFIG, type AppConfig } from '../config';
import { ModelProfilesService } from '../judge/model-profiles.service';
import { AdaptersService } from '../adapters/adapters.service';
import { toPublicUser } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { InviteService } from '../invite.service';
import { AdminOnly, AuthUser, CurrentUser } from '../common/auth.guard';
import { hashPassword } from '../common/password';
import { CreditLedger, GradingTask, JudgeRecord, Org, RedeemCode, User } from '../entities';

class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() userId?: number;
  /** 按组织筛选 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) orgId?: number;
}

class StatsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) orgId?: number;
}

/** 控制台改模型配置；不传的字段保持原样，传空字符串表示退回环境变量 */
class UpdateModelDto {
  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsString() @MaxLength(300) baseUrl?: string;
  @IsOptional() @IsString() @MaxLength(400) apiKey?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(2) temperature?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(256) @Max(200_000) maxTokens?: number;
  @IsOptional() @IsIn(['', 'none', 'minimal', 'low', 'medium', 'high']) reasoningEffort?: string;
  @IsOptional() @IsIn(['', 'none', 'minimal', 'low', 'medium', 'high']) ocrReasoningEffort?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) sampleCount?: number;
  @IsOptional() @IsBoolean() scoreWithImage?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1000) @Max(120_000) timeoutMs?: number;
}

class CreateUserDto {
  @IsString() @Length(3, 32) username!: string;
  @IsString() @Length(8, 128) password!: string;
  @IsOptional() @IsIn(['user', 'admin']) role?: 'user' | 'admin';
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000) credits?: number;
}

class UpdateUserDto {
  @IsOptional() @IsIn(['user', 'admin']) role?: 'user' | 'admin';
  @IsOptional() @IsBoolean() disabled?: boolean;
  @IsOptional() @IsString() @Length(8, 128) password?: string;
  /** 改所属组织；null 表示移出组织 */
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number) @IsInt() @Min(1) orgId?: number | null;
}

class AdjustDto {
  @Type(() => Number) @IsInt() @Min(-1_000_000) @Max(1_000_000) delta!: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class CreateCodesDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(500) count!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100_000) credits!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) maxUses?: number;
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class UpdateCodeDto {
  @IsBoolean() disabled!: boolean;
}

class CreateInvitesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) count?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) maxUses?: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000) credits!: number;
  /** 注册后自动加入的组织；不填表示不属于任何组织 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) orgId?: number;
  @IsDateString() expiresAt!: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class UpdateInviteDto {
  @IsBoolean() disabled!: boolean;
}

class PresetDto {
  @IsString() @MaxLength(100) name!: string;
  @IsString() @MaxLength(255) hostPattern!: string;
  @IsOptional() @IsString() @MaxLength(200) pathPattern?: string;
  @IsObject() config!: AdapterConfig;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsIn(['public', 'private']) scope?: 'public' | 'private';
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class PresetPatchDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(255) hostPattern?: string;
  @IsOptional() @IsString() @MaxLength(200) pathPattern?: string;
  @IsOptional() @IsObject() config?: AdapterConfig;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsIn(['public', 'private']) scope?: 'public' | 'private';
  @IsOptional() @IsBoolean() enabled?: boolean;
}

const paging = (q: PageQuery) => {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 20;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

@AdminOnly()
@Controller('api/admin')
export class AdminController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(CreditLedger) private readonly ledger: Repository<CreditLedger>,
    @InjectRepository(RedeemCode) private readonly codes: Repository<RedeemCode>,
    @InjectRepository(GradingTask) private readonly tasks: Repository<GradingTask>,
    @InjectRepository(JudgeRecord) private readonly records: Repository<JudgeRecord>,
    @InjectRepository(Org) private readonly orgs: Repository<Org>,
    private readonly billing: BillingService,
    private readonly adapters: AdaptersService,
    private readonly invites: InviteService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly modelProfiles: ModelProfilesService,
  ) {}

  /** orgId 给出时只统计该组织成员 */
  @Get('stats')
  async stats(@Query() q: StatsQuery) {
    const since = new Date(Date.now() - 13 * 86400_000);
    since.setUTCHours(0, 0, 0, 0);
    const org = q.orgId ?? null;
    // 成员条件：用户表用 u.orgId，记录和任务按 userId 关联用户
    const inOrg = (col: string) => (org === null ? '1 = 1' : `${col} IN (SELECT id FROM users WHERE orgId = ?)`);
    const args = org === null ? [] : [org];
    const one = async (sql: string, extra: unknown[] = []) => (await this.ds.query(sql, [...extra, ...args]))[0] ?? {};
    const [u, t, r] = await Promise.all([
      one(`SELECT COUNT(*) AS n, COALESCE(SUM(credits), 0) AS credits FROM users WHERE ${org === null ? '1 = 1' : 'orgId = ?'}`),
      one(`SELECT COUNT(*) AS n FROM tasks WHERE ${inOrg('userId')}`),
      one(`SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
             FROM judge_records WHERE ${inOrg('userId')}`),
    ]);
    const daily = await this.ds.query(
      `SELECT date(createdAt) AS day,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              COUNT(DISTINCT userId) AS users
         FROM judge_records WHERE createdAt >= ? AND ${inOrg('userId')} GROUP BY day ORDER BY day`,
      [since.toISOString().replace('T', ' ').slice(0, 19), ...args],
    );
    const avg = await this.ds.query(
      `SELECT AVG(latencyMs) AS latency, AVG(confidence) AS confidence,
              AVG(CASE WHEN finalScore IS NOT NULL AND aiScore IS NOT NULL THEN ABS(finalScore - aiScore) END) AS drift,
              SUM(CASE WHEN confirmedAt IS NOT NULL THEN 1 ELSE 0 END) AS confirmed
         FROM judge_records WHERE status = 'done' AND ${inOrg('userId')}`,
      args,
    );
    return {
      users: Number(u.n ?? 0),
      tasks: Number(t.n ?? 0),
      records: Number(r.done ?? 0),
      failed: Number(r.failed ?? 0),
      creditsOutstanding: Number(u.credits ?? 0),
      avgLatencyMs: Math.round(Number(avg[0]?.latency ?? 0)),
      avgConfidence: Number(avg[0]?.confidence ?? 0),
      avgDrift: Number(avg[0]?.drift ?? 0),
      confirmed: Number(avg[0]?.confirmed ?? 0),
      daily: daily.map((d: Record<string, unknown>) => ({
        day: d.day,
        done: Number(d.done),
        failed: Number(d.failed),
        users: Number(d.users),
      })),
    };
  }

  // ---------- 模型 ----------

  /** 所有模型方案 + 近 7 天各模型的评分量；密钥只报「有没有配」 */
  @Get('model')
  async modelInfo() {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
    const rows = await this.ds.query(
      `SELECT model,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              AVG(CASE WHEN status = 'done' THEN latencyMs END) AS latency
         FROM judge_records WHERE createdAt >= ? GROUP BY model ORDER BY total DESC`,
      [since],
    );
    return {
      profiles: this.modelProfiles.list(),
      /** 这些参数只能在环境变量里改 */
      fixed: {
        maxRetries: this.cfg.model.maxRetries,
        retryDelayMs: this.cfg.model.retryDelayMs,
        ocrTwoPass: this.cfg.ocr.twoPass,
        maxImageBytes: this.cfg.maxImageBytes,
      },
      gold: { enabled: this.cfg.gold.enabled, maxExamples: this.cfg.gold.maxExamples },
      usage: rows.map((r: Record<string, unknown>) => ({
        model: String(r.model || '(未记录)'),
        total: Number(r.total),
        done: Number(r.done ?? 0),
        failed: Number(r.failed ?? 0),
        avgLatencyMs: Math.round(Number(r.latency ?? 0)),
      })),
    };
  }

  /** 新增或修改一个方案；保存前会真的发一张图探测，读不了图的模型直接拒绝 */
  @Put('model/:name')
  async saveModel(@CurrentUser() u: AuthUser, @Param('name') name: string, @Body() dto: UpdateModelDto) {
    const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    await this.modelProfiles.save(name, patch, { id: u.id, name: u.username });
    return this.modelInfo();
  }

  /** 重新做一次视觉探测（改完供应商配置、或怀疑模型换了之后用） */
  @Post('model/:name/test')
  async testModel(@Param('name') name: string) {
    return this.modelProfiles.test(name);
  }

  /** 恢复为环境变量：default 删掉覆盖行，其他方案只清字段 */
  @Post('model/:name/reset')
  async resetModel(@Param('name') name: string) {
    await this.modelProfiles.reset(name);
    return this.modelInfo();
  }

  @Delete('model/:name')
  async deleteModel(@Param('name') name: string) {
    await this.modelProfiles.remove(name);
    return this.modelInfo();
  }

  // ---------- 用户 ----------

  @Get('users')
  async listUsers(@Query() q: PageQuery) {
    const { page, pageSize, skip, take } = paging(q);
    const qb = this.users.createQueryBuilder('u').orderBy('u.id', 'DESC').skip(skip).take(take);
    if (q.q) qb.andWhere('u.username LIKE :q', { q: `%${q.q}%` });
    if (q.orgId) qb.andWhere('u.orgId = :orgId', { orgId: q.orgId });
    const [rows, total] = await qb.getManyAndCount();
    const orgIds = [...new Set(rows.map((r) => r.orgId).filter((x): x is number => x !== null))];
    const orgNames = new Map(orgIds.length ? (await this.orgs.findBy({ id: In(orgIds) })).map((o) => [o.id, o.name] as const) : []);
    const ids = rows.map((r) => r.id);
    const usage = ids.length
      ? await this.ds.query(
          `SELECT userId, COUNT(*) AS n, MAX(createdAt) AS last FROM judge_records
            WHERE status = 'done' AND userId IN (${ids.map(() => '?').join(',')}) GROUP BY userId`,
          ids,
        )
      : [];
    const byId = new Map<number, { n: number; last: string }>(usage.map((u: any) => [Number(u.userId), u]));
    return {
      total,
      page,
      pageSize,
      items: rows.map((u) => ({
        ...toPublicUser(u),
        disabled: u.disabled,
        org: u.orgId === null ? null : { id: u.orgId, name: orgNames.get(u.orgId) ?? `#${u.orgId}` },
        lastLoginAt: u.lastLoginAt,
        judged: Number(byId.get(u.id)?.n ?? 0),
        lastJudgeAt: byId.get(u.id)?.last ?? null,
      })),
    };
  }

  @Post('users')
  async createUser(@Body() dto: CreateUserDto) {
    if (await this.users.existsBy({ username: dto.username })) throw new BadRequestException('用户名已存在');
    let u = await this.users.save(
      this.users.create({
        username: dto.username,
        passwordHash: await hashPassword(dto.password),
        role: dto.role ?? 'user',
        credits: 0,
      }),
    );
    if (dto.credits) u.credits = this.billing.adjust(u.id, dto.credits, 'admin', null, '管理员开户');
    return toPublicUser(u);
  }

  @Patch('users/:id')
  async updateUser(@CurrentUser() me: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    const u = await this.users.findOneBy({ id });
    if (!u) throw new NotFoundException('用户不存在');
    if (id === me.id && (dto.disabled || dto.role === 'user')) throw new BadRequestException('不能停用或降级自己');
    if (dto.role) u.role = dto.role;
    if (dto.orgId !== undefined) {
      if (dto.orgId !== null && !(await this.orgs.existsBy({ id: dto.orgId }))) throw new BadRequestException('组织不存在');
      u.orgId = dto.orgId;
    }
    if (dto.disabled !== undefined) {
      u.disabled = dto.disabled;
      u.tokenVersion += 1;
    }
    if (dto.password) {
      u.passwordHash = await hashPassword(dto.password);
      u.tokenVersion += 1;
    }
    await this.users.save(u);
    return { ...toPublicUser(u), disabled: u.disabled, orgId: u.orgId };
  }

  @HttpCode(200)
  @Post('users/:id/credits')
  adjust(@CurrentUser() me: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: AdjustDto) {
    const balance = this.billing.adjust(id, dto.delta, 'admin', me.id, dto.note || `管理员 ${me.username} 调整`);
    return { balance };
  }

  @Get('ledger')
  async listLedger(@Query() q: PageQuery) {
    const { page, pageSize, skip, take } = paging(q);
    const [items, total] = await this.ledger.findAndCount({
      where: q.userId ? { userId: q.userId } : {},
      order: { id: 'DESC' },
      skip,
      take,
    });
    return { items, total, page, pageSize };
  }

  // ---------- 兑换码 ----------

  @Get('codes')
  async listCodes(@Query() q: PageQuery) {
    const { page, pageSize, skip, take } = paging(q);
    const qb = this.codes.createQueryBuilder('c').orderBy('c.id', 'DESC').skip(skip).take(take);
    if (q.q) qb.where('c.code LIKE :q OR c.note LIKE :q', { q: `%${q.q}%` });
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  @Post('codes')
  createCodes(@CurrentUser() me: AuthUser, @Body() dto: CreateCodesDto) {
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt < new Date()) throw new BadRequestException('过期时间必须在未来');
    const codes = this.billing.createCodes({
      count: dto.count,
      credits: dto.credits,
      maxUses: dto.maxUses ?? 1,
      expiresAt,
      note: dto.note ?? '',
      createdBy: me.id,
    });
    return { codes };
  }

  @Get('invites')
  listInvites(@Query() q: PageQuery) {
    const { page, pageSize } = paging(q);
    return this.invites.list(q.q, page, pageSize);
  }

  @Post('invites')
  async createInvites(@CurrentUser() me: AuthUser, @Body() dto: CreateInvitesDto) {
    const expiresAt = new Date(dto.expiresAt);
    if (expiresAt < new Date()) throw new BadRequestException('过期时间必须在未来');
    return { tokens: await this.invites.create(dto.orgId ?? null, me.id, dto.count ?? 1, dto.maxUses ?? 10, dto.credits, expiresAt, dto.note ?? '') };
  }

  @Patch('invites/:id')
  updateInvite(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateInviteDto) {
    return this.invites.disable(id, dto.disabled);
  }

  @Patch('codes/:id')
  async updateCode(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCodeDto) {
    const r = await this.codes.update({ id }, { disabled: dto.disabled });
    if (!r.affected) throw new NotFoundException('兑换码不存在');
    return { ok: true };
  }

  // ---------- 评分记录 ----------

  @Get('records')
  async listRecords(@Query() q: PageQuery) {
    const { page, pageSize, skip, take } = paging(q);
    const qb = this.records
      .createQueryBuilder('r')
      .leftJoin(User, 'u', 'u.id = r.userId')
      .leftJoin(GradingTask, 't', 't.id = r.taskId')
      .select([
        'r.id AS id',
        'r.userId AS userId',
        'u.username AS username',
        'r.taskId AS taskId',
        't.examTitle AS examTitle',
        't.questionNo AS questionNo',
        't.platformHost AS platformHost',
        't.maxScore AS maxScore',
        'r.status AS status',
        'r.aiScore AS aiScore',
        'r.finalScore AS finalScore',
        'r.confidence AS confidence',
        'r.model AS model',
        'r.modelProfile AS modelProfile',
        'r.latencyMs AS latencyMs',
        'r.error AS error',
        'r.createdAt AS createdAt',
      ])
      .orderBy('r.id', 'DESC')
      .offset(skip)
      .limit(take);
    if (q.userId) qb.andWhere('r.userId = :uid', { uid: q.userId });
    if (q.orgId) qb.andWhere('u.orgId = :orgId', { orgId: q.orgId });
    if (q.q) qb.andWhere('(u.username LIKE :q OR t.examTitle LIKE :q OR t.platformHost LIKE :q)', { q: `%${q.q}%` });
    const items = await qb.getRawMany();
    const total = await qb.getCount();
    return { items, total, page, pageSize };
  }

  // ---------- 适配预设 ----------

  @Get('presets')
  listPresets(@Query('q') q?: string) {
    return this.adapters.listAll(q);
  }

  @Post('presets')
  createPreset(@Body() dto: PresetDto) {
    return this.adapters.adminCreate(dto);
  }

  @Patch('presets/:id')
  updatePreset(@Param('id', ParseIntPipe) id: number, @Body() dto: PresetPatchDto) {
    return this.adapters.adminUpdate(id, dto);
  }

  @Delete('presets/:id')
  deletePreset(@Param('id', ParseIntPipe) id: number) {
    return this.adapters.adminDelete(id);
  }
}
