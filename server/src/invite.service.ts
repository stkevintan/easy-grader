import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager, Repository } from 'typeorm';
import { InviteToken, ManagementUnit } from './entities';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const makeToken = () => `EGI-${randomBytes(18).toString('base64url').toUpperCase()}`;

@Injectable()
export class InviteService {
  constructor(
    @InjectRepository(InviteToken) private readonly tokens: Repository<InviteToken>,
    @InjectRepository(ManagementUnit) private readonly units: Repository<ManagementUnit>,
  ) {}

  async create(unitId: number, createdBy: number, count: number, maxUses: number, expiresAt: Date | null, note: string) {
    if (!(await this.units.existsBy({ id: unitId, enabled: true }))) throw new BadRequestException('管理单元不存在或已停用');
    const result: string[] = [];
    while (result.length < count) {
      const token = makeToken();
      try {
        await this.tokens.insert({ tokenHash: hashToken(token), unitId, maxUses, expiresAt, note: note.slice(0, 200), createdBy });
        result.push(token);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
      }
    }
    return result;
  }

  list(q?: string) {
    const qb = this.tokens.createQueryBuilder('t').orderBy('t.id', 'DESC').take(500);
    if (q) qb.where('t.note LIKE :q OR t.tokenHash LIKE :q', { q: `%${q}%` });
    return qb.getMany();
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
    const unitRepo = manager?.getRepository(ManagementUnit) ?? this.units;
    const row = await tokenRepo.findOneBy({ tokenHash: hashToken(token) });
    if (!row || row.disabled) throw new BadRequestException('邀请令牌无效');
    if (row.expiresAt && row.expiresAt < new Date()) throw new BadRequestException('邀请令牌已过期');
    if (!(await unitRepo.existsBy({ id: row.unitId, enabled: true }))) throw new BadRequestException('邀请令牌所属单元已停用');
    const result = await tokenRepo.createQueryBuilder()
      .update(InviteToken)
      .set({ usedCount: () => 'usedCount + 1' })
      .where('id = :id AND disabled = 0 AND usedCount < maxUses', { id: row.id })
      .execute();
    if (!result.affected) throw new BadRequestException('邀请令牌已用完');
    return row.unitId;
  }
}
