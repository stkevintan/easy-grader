import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdapterPreset, GradingTask, JudgeRecord, ManagementUnit, UnitMembership, User } from './entities';

@Injectable()
export class UnitService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(ManagementUnit) private readonly units: Repository<ManagementUnit>,
    @InjectRepository(UnitMembership) private readonly memberships: Repository<UnitMembership>,
    @InjectRepository(GradingTask) private readonly tasks: Repository<GradingTask>,
    @InjectRepository(JudgeRecord) private readonly records: Repository<JudgeRecord>,
    @InjectRepository(AdapterPreset) private readonly presets: Repository<AdapterPreset>,
  ) {}

  async onApplicationBootstrap() {
    for (const user of await this.users.find()) await this.ensurePersonalUnit(user);
  }

  async ensurePersonalUnit(user: User): Promise<ManagementUnit> {
    const membership = await this.memberships.findOne({ where: { userId: user.id, role: 'owner' }, order: { id: 'ASC' } });
    if (membership) {
      const unit = await this.units.findOneByOrFail({ id: membership.unitId });
      await this.backfill(user.id, unit.id);
      return unit;
    }
    const unit = await this.units.save(this.units.create({
      name: `${user.username}的个人单元`,
      description: '系统自动创建的个人管理单元',
      ownerId: user.id,
      enabled: true,
    }));
    await this.memberships.save(this.memberships.create({ unitId: unit.id, userId: user.id, role: 'owner' }));
    await this.backfill(user.id, unit.id);
    return unit;
  }

  async listForUser(userId: number) {
    return this.units.createQueryBuilder('u')
      .innerJoin(UnitMembership, 'm', 'm.unitId = u.id AND m.userId = :userId', { userId })
      .where('u.enabled = 1')
      .select(['u.id AS id', 'u.name AS name', 'u.description AS description', 'm.role AS role'])
      .orderBy('u.id', 'ASC')
      .getRawMany();
  }

  private async backfill(userId: number, unitId: number) {
    await this.tasks.createQueryBuilder().update().set({ unitId }).where('userId = :userId AND unitId IS NULL', { userId }).execute();
    await this.records.createQueryBuilder().update().set({ unitId }).where('userId = :userId AND unitId IS NULL', { userId }).execute();
    await this.presets.createQueryBuilder().update().set({ unitId }).where('ownerId = :userId AND unitId IS NULL', { userId }).execute();
  }
}
