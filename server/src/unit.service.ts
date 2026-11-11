import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AdapterPreset, GradingTask, JudgeRecord, ManagementUnit, UnitMembership, User } from './entities';

/** 上一版用 description 标记个人单元；只在升级迁移时用来认领，认领后会写成 kind='personal' */
const LEGACY_PERSONAL_DESC = '系统自动创建的个人管理单元';

@Injectable()
export class UnitService implements OnApplicationBootstrap {
  /** 同一个用户的并发 provisioning 合并成一次，避免启动钩子和注册/开户同时创建两个个人单元 */
  private readonly provisioning = new Map<number, Promise<ManagementUnit>>();

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(ManagementUnit) private readonly units: Repository<ManagementUnit>,
    @InjectRepository(UnitMembership) private readonly memberships: Repository<UnitMembership>,
    @InjectRepository(GradingTask) private readonly tasks: Repository<GradingTask>,
    @InjectRepository(JudgeRecord) private readonly records: Repository<JudgeRecord>,
    @InjectRepository(AdapterPreset) private readonly presets: Repository<AdapterPreset>,
  ) {}

  /** 升级兼容：为所有还没有个人单元的老用户补一个；新用户由注册/开户流程负责 */
  async onApplicationBootstrap() {
    for (const user of await this.users.find()) await this.ensurePersonalUnit(user);
  }

  /**
   * 保证用户有一个个人管理单元，并把还没有 unitId 的历史数据迁进去。
   *
   * personalUnitId 是服务端维护的稳定映射；kind='personal' 是单元上的持久标记。
   * 两者都不受管理接口的 name/description 修改影响，避免改名后认不出个人单元。
   */
  async ensurePersonalUnit(user: User, manager?: EntityManager): Promise<ManagementUnit> {
    // 事务内的调用（注册）直接执行，不参与进程内的并发合并
    if (manager) return this.provision(user, manager);

    const running = this.provisioning.get(user.id);
    if (running) return running;
    const p = this.provision(user).finally(() => this.provisioning.delete(user.id));
    this.provisioning.set(user.id, p);
    return p;
  }

  private async provision(user: User, manager?: EntityManager): Promise<ManagementUnit> {
    const users = manager ? manager.getRepository(User) : this.users;
    const units = manager ? manager.getRepository(ManagementUnit) : this.units;
    const memberships = manager ? manager.getRepository(UnitMembership) : this.memberships;
    const tasks = manager ? manager.getRepository(GradingTask) : this.tasks;
    const records = manager ? manager.getRepository(JudgeRecord) : this.records;
    const presets = manager ? manager.getRepository(AdapterPreset) : this.presets;

    let personal: ManagementUnit | null = null;
    if (user.personalUnitId) {
      personal = await units.findOneBy({ id: user.personalUnitId });
    }
    if (!personal) {
      personal = await units.findOneBy({ ownerId: user.id, kind: 'personal' });
    }
    if (!personal) {
      // 升级：上一版创建的个人单元只有 description 标记，认领后补上 kind
      personal = await units.findOneBy({ ownerId: user.id, description: LEGACY_PERSONAL_DESC });
      if (personal) {
        personal.kind = 'personal';
        personal = await units.save(personal);
      }
    }
    if (!personal) {
      personal = await units.save(
        units.create({
          name: await this.personalUnitName(user, units),
          description: LEGACY_PERSONAL_DESC,
          ownerId: user.id,
          kind: 'personal',
          enabled: true,
        }),
      );
    }
    if (!(await memberships.findOneBy({ unitId: personal.id, userId: user.id }))) {
      await memberships.save(memberships.create({ unitId: personal.id, userId: user.id, role: 'owner' }));
    }
    if (user.personalUnitId !== personal.id) {
      user.personalUnitId = personal.id;
      await users.update(user.id, { personalUnitId: personal.id });
    }
    await tasks.createQueryBuilder().update().set({ unitId: personal.id }).where('userId = :userId AND unitId IS NULL', { userId: user.id }).execute();
    await records.createQueryBuilder().update().set({ unitId: personal.id }).where('userId = :userId AND unitId IS NULL', { userId: user.id }).execute();
    await presets.createQueryBuilder().update().set({ unitId: personal.id }).where('ownerId = :userId AND unitId IS NULL', { userId: user.id }).execute();
    return personal;
  }

  /** 单元名全局唯一；管理员可能已经占用了同名单元，这里退让一下而不是让启动失败 */
  private async personalUnitName(user: User, units: Repository<ManagementUnit>) {
    const base = `${user.username}的个人单元`.slice(0, 100);
    if (!(await units.existsBy({ name: base }))) return base;
    const suffix = ` #${user.id}`;
    return `${base.slice(0, 100 - suffix.length)}${suffix}`;
  }

  async listForUser(userId: number) {
    return this.units.createQueryBuilder('u')
      .innerJoin(UnitMembership, 'm', 'm.unitId = u.id AND m.userId = :userId', { userId })
      .where('u.enabled = 1')
      .select(['u.id AS id', 'u.name AS name', 'u.description AS description', 'm.role AS role'])
      .orderBy('u.id', 'ASC')
      .getRawMany();
  }
}
