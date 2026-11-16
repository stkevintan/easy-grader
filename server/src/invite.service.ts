import { BadRequestException, Injectable, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager, Repository } from 'typeorm';
import { InviteToken, Org } from './entities';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const makeToken = () => `EGI-${randomBytes(18).toString('base64url').toUpperCase()}`;

@Injectable()
export class InviteService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(InviteToken) private readonly tokens: Repository<InviteToken>,
    @InjectRepository(Org) private readonly orgs: Repository<Org>,
  ) {}

  /**
   * 从管理单元迁移过来的旧邀请，同步表结构时 unitId 的值会被带进 orgId，指向不存在的组织。
   * 清成 null，免得以后新建的组织正好用上这个 id。组织只停用不删除，所以每次启动跑一遍也安全。
   */
  async onApplicationBootstrap() {
    await this.tokens.query('UPDATE invite_tokens SET orgId = NULL WHERE orgId IS NOT NULL AND orgId NOT IN (SELECT id FROM orgs)');
  }

  /** orgId 为 null 时发不属于任何组织的邀请 */
  async create(orgId: number | null, createdBy: number, count: number, maxUses: number, credits: number, expiresAt: Date, note: string) {
    if (orgId !== null && !(await this.orgs.existsBy({ id: orgId, enabled: true }))) throw new BadRequestException('组织不存在或已停用');
    const result: { id: number; token: string }[] = [];
    while (result.length < count) {
      const token = makeToken();
      try {
        await this.tokens.insert({ tokenHash: hashToken(token), orgId, credits, maxUses, expiresAt, note: note.slice(0, 200), createdBy });
        const saved = await this.tokens.findOneByOrFail({ tokenHash: hashToken(token) });
        result.push({ id: saved.id, token });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
      }
    }
    return result;
  }

  async list(q?: string, page = 1, pageSize = 20) {
    const qb = this.tokens.createQueryBuilder('t').orderBy('t.id', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    if (q) qb.where('t.note LIKE :q OR t.tokenHash LIKE :q', { q: `%${q}%` });
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async disable(id: number, disabled: boolean) {
    const result = await this.tokens.update({ id }, { disabled });
    if (!result.affected) throw new NotFoundException('邀请令牌不存在');
    return { ok: true };
  }

  async consume(rawToken: string, manager?: EntityManager) {
    const token = rawToken.trim().toUpperCase();
    if (!token) throw new BadRequestException('请输入邀请令牌');
    const tokenRepo = manager?.getRepository(InviteToken) ?? this.tokens;
    const orgRepo = manager?.getRepository(Org) ?? this.orgs;
    const row = await tokenRepo.findOneBy({ tokenHash: hashToken(token) });
    if (!row || row.disabled) throw new BadRequestException('邀请令牌无效');
    if (row.expiresAt && row.expiresAt < new Date()) throw new BadRequestException('邀请令牌已过期');
    // 停用组织后，它的邀请不能再用
    if (row.orgId !== null && !(await orgRepo.existsBy({ id: row.orgId, enabled: true }))) throw new BadRequestException('邀请令牌所属组织已停用');
    const result = await tokenRepo.createQueryBuilder()
      .update(InviteToken)
      .set({ usedCount: () => 'usedCount + 1' })
      .where('id = :id AND disabled = 0 AND usedCount < maxUses', { id: row.id })
      .execute();
    if (!result.affected) throw new BadRequestException('邀请令牌已用完');
    return { orgId: row.orgId, credits: row.credits };
  }
}
