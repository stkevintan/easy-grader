import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
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
      } catch {
        // Extremely unlikely hash collision; generate another token.
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

  async consume(rawToken: string) {
    const token = rawToken.trim().toUpperCase();
    if (!token) throw new BadRequestException('请输入邀请令牌');
    const row = await this.tokens.findOneBy({ tokenHash: hashToken(token) });
    if (!row || row.disabled) throw new BadRequestException('邀请令牌无效');
    if (row.expiresAt && row.expiresAt < new Date()) throw new BadRequestException('邀请令牌已过期');
    if (row.usedCount >= row.maxUses) throw new BadRequestException('邀请令牌已用完');
    row.usedCount += 1;
    await this.tokens.save(row);
    return row.unitId;
  }
}
