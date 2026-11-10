import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { Repository } from 'typeorm';
import { AdminOnly, AuthUser, CurrentUser, UnitAccess } from '../common/auth.guard';
import { ManagementUnit, UnitMembership, UnitRole, User } from '../entities';

class CreateUnitDto {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
class UpdateUnitDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
class MemberDto {
  @IsString() @Length(3, 32) username!: string;
  @IsIn(['owner', 'manager', 'grader', 'viewer']) role!: UnitRole;
}

@AdminOnly()
@Controller('api/admin/units')
export class UnitController {
  constructor(
    @InjectRepository(ManagementUnit) private readonly units: Repository<ManagementUnit>,
    @InjectRepository(UnitMembership) private readonly memberships: Repository<UnitMembership>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  @Get()
  async list() {
    const units = await this.units.find({ order: { id: 'DESC' } });
    const counts = await this.memberships.createQueryBuilder('m').select('m.unitId', 'unitId').addSelect('COUNT(*)', 'count').groupBy('m.unitId').getRawMany();
    const countByUnit = new Map(counts.map((x) => [Number(x.unitId), Number(x.count)]));
    return units.map((u) => ({ ...u, memberCount: countByUnit.get(u.id) ?? 0 }));
  }

  @Post()
  async create(@CurrentUser() me: AuthUser, @Body() dto: CreateUnitDto) {
    if (await this.units.existsBy({ name: dto.name })) throw new BadRequestException('管理单元名称已存在');
    const unit = await this.units.save(this.units.create({ name: dto.name, description: dto.description ?? '', ownerId: me.id }));
    await this.memberships.save(this.memberships.create({ unitId: unit.id, userId: me.id, role: 'owner' }));
    return unit;
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUnitDto) {
    const unit = await this.units.findOneBy({ id });
    if (!unit) throw new BadRequestException('管理单元不存在');
    Object.assign(unit, dto);
    return this.units.save(unit);
  }

  @UnitAccess(['owner', 'manager'])
  @Get(':id/members')
  async members(@Param('id', ParseIntPipe) unitId: number) {
    const rows = await this.memberships.find({ where: { unitId }, order: { id: 'ASC' } });
    const users = rows.length ? await this.users.findByIds(rows.map((r) => r.userId)) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({ id: r.id, userId: r.userId, username: byId.get(r.userId)?.username ?? '—', role: r.role, createdAt: r.createdAt }));
  }

  @Post(':id/members')
  async addMember(@Param('id', ParseIntPipe) unitId: number, @Body() dto: MemberDto) {
    const user = await this.users.findOneBy({ username: dto.username });
    if (!user) throw new BadRequestException('用户不存在');
    if (!(await this.units.existsBy({ id: unitId }))) throw new BadRequestException('管理单元不存在');
    const existing = await this.memberships.findOneBy({ unitId, userId: user.id });
    if (existing) { existing.role = dto.role; return this.memberships.save(existing); }
    return this.memberships.save(this.memberships.create({ unitId, userId: user.id, role: dto.role }));
  }

  @Patch(':unitId/members/:userId')
  async updateMember(@Param('unitId', ParseIntPipe) unitId: number, @Param('userId', ParseIntPipe) userId: number, @Body() dto: MemberDto) {
    const m = await this.memberships.findOneBy({ unitId, userId });
    if (!m) throw new BadRequestException('成员不存在');
    m.role = dto.role;
    return this.memberships.save(m);
  }

  @Delete(':unitId/members/:userId')
  async removeMember(@Param('unitId', ParseIntPipe) unitId: number, @Param('userId', ParseIntPipe) userId: number) {
    const r = await this.memberships.delete({ unitId, userId });
    if (!r.affected) throw new BadRequestException('成员不存在');
    return { ok: true };
  }
}
