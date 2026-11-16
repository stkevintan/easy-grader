import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { DataSource, Not, Repository } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AdminOnly } from '../common/auth.guard';
import { Org, User } from '../entities';

class CreateOrgDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

class UpdateOrgDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/** 组织：只是分组。系统管理员建、改名、停用，并查看成员和用量 */
@AdminOnly()
@Controller('api/admin/orgs')
export class OrgController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Org) private readonly orgs: Repository<Org>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  @Get()
  async list() {
    const orgs = await this.orgs.find({ order: { id: 'DESC' } });
    const counts: { orgId: number; n: number }[] = await this.ds.query(
      'SELECT orgId, COUNT(*) AS n FROM users WHERE orgId IS NOT NULL GROUP BY orgId',
    );
    const byOrg = new Map(counts.map((c) => [Number(c.orgId), Number(c.n)]));
    return orgs.map((o) => ({ ...o, memberCount: byOrg.get(o.id) ?? 0 }));
  }

  @Post()
  async create(@Body() dto: CreateOrgDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('请填写组织名称');
    if (await this.orgs.existsBy({ name })) throw new BadRequestException('组织名称已存在');
    return this.orgs.save(this.orgs.create({ name, description: dto.description?.trim() ?? '' }));
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateOrgDto) {
    const org = await this.orgs.findOneBy({ id });
    if (!org) throw new NotFoundException('组织不存在');
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('请填写组织名称');
      if (await this.orgs.existsBy({ name, id: Not(id) })) throw new BadRequestException('组织名称已存在');
      org.name = name;
    }
    if (dto.description !== undefined) org.description = dto.description.trim();
    if (dto.enabled !== undefined) org.enabled = dto.enabled;
    return this.orgs.save(org);
  }

  /** 成员和每个人的用量（成功评分数、最近评分时间、剩余额度） */
  @Get(':id/members')
  async members(@Param('id', ParseIntPipe) id: number) {
    if (!(await this.orgs.existsBy({ id }))) throw new NotFoundException('组织不存在');
    const rows: Record<string, unknown>[] = await this.ds.query(
      `SELECT u.id, u.username, u.role, u.credits, u.disabled, u.createdAt,
              COUNT(r.id) AS judged, MAX(r.createdAt) AS lastJudgeAt
         FROM users u LEFT JOIN judge_records r ON r.userId = u.id AND r.status = 'done'
        WHERE u.orgId = ? GROUP BY u.id ORDER BY u.id`,
      [id],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      role: r.role,
      credits: Number(r.credits),
      disabled: !!r.disabled,
      createdAt: r.createdAt,
      judged: Number(r.judged),
      lastJudgeAt: r.lastJudgeAt ?? null,
    }));
  }
}
