import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import type { AdapterConfig } from '../adapters/adapter-config';
import { AdaptersService } from '../adapters/adapters.service';
import { toPublicUser } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { InviteService } from '../invite.service';
import { AdminOnly, AuthUser, CurrentUser } from '../common/auth.guard';
import { hashPassword } from '../common/password';
import { CreditLedger, GradingTask, JudgeRecord, RedeemCode, User } from '../entities';
import { UnitService } from '../unit.service';

class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() userId?: number;
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
  @Type(() => Number) @IsInt() @Min(1) unitId!: number;
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
    private readonly billing: BillingService,
    private readonly adapters: AdaptersService,
    private readonly invites: InviteService,
    private readonly units: UnitService,
  ) {}

  @Get('stats')
  async stats() {
    const since = new Date(Date.now() - 13 * 86400_000);
    since.setUTCHours(0, 0, 0, 0);
    const [users, tasks, records, failed, credits] = await Promise.all([
      this.users.count(),
      this.tasks.count(),
      this.records.countBy({ status: 'done' }),
      this.records.countBy({ status: 'failed' }),
      this.users.sum('credits'),
    ]);
    const daily = await this.ds.query(
      `SELECT date(createdAt) AS day,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              COUNT(DISTINCT userId) AS users
         FROM judge_records WHERE createdAt >= ? GROUP BY day ORDER BY day`,
      [since.toISOString().replace('T', ' ').slice(0, 19)],
    );
    const avg = await this.ds.query(
      `SELECT AVG(latencyMs) AS latency, AVG(confidence) AS confidence,
              AVG(CASE WHEN finalScore IS NOT NULL AND aiScore IS NOT NULL THEN ABS(finalScore - aiScore) END) AS drift,
              SUM(CASE WHEN confirmedAt IS NOT NULL THEN 1 ELSE 0 END) AS confirmed
         FROM judge_records WHERE status = 'done'`,
    );
    return {
      users,
      tasks,
      records,
      failed,
      creditsOutstanding: credits ?? 0,
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

  // ---------- 用户 ----------

  @Get('users')
  async listUsers(@Query() q: PageQuery) {
    const { page, pageSize, skip, take } = paging(q);
    const qb = this.users.createQueryBuilder('u').orderBy('u.id', 'DESC').skip(skip).take(take);
    if (q.q) qb.where('u.username LIKE :q', { q: `%${q.q}%` });
    const [rows, total] = await qb.getManyAndCount();
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
    await this.units.ensurePersonalUnit(u);
    return toPublicUser(u);
  }

  @Patch('users/:id')
  async updateUser(@CurrentUser() me: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    const u = await this.users.findOneBy({ id });
    if (!u) throw new NotFoundException('用户不存在');
    if (id === me.id && (dto.disabled || dto.role === 'user')) throw new BadRequestException('不能停用或降级自己');
    if (dto.role) u.role = dto.role;
    if (dto.disabled !== undefined) {
      u.disabled = dto.disabled;
      u.tokenVersion += 1;
    }
    if (dto.password) {
      u.passwordHash = await hashPassword(dto.password);
      u.tokenVersion += 1;
    }
    await this.users.save(u);
    return { ...toPublicUser(u), disabled: u.disabled };
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
    return { tokens: await this.invites.create(dto.unitId, me.id, dto.count ?? 1, dto.maxUses ?? 10, dto.credits, expiresAt, dto.note ?? '') };
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
        'r.latencyMs AS latencyMs',
        'r.error AS error',
        'r.createdAt AS createdAt',
      ])
      .orderBy('r.id', 'DESC')
      .offset(skip)
      .limit(take);
    if (q.userId) qb.andWhere('r.userId = :uid', { uid: q.userId });
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
