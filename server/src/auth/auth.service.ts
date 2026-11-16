import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { hashPassword, verifyPassword } from '../common/password';
import { APP_CONFIG, AppConfig } from '../config';
import { Org, User } from '../entities';
import { InviteService } from '../invite.service';

export interface PublicUser {
  id: number;
  username: string;
  role: string;
  credits: number;
  createdAt: Date;
}

export const toPublicUser = (u: User): PublicUser => ({
  id: u.id,
  username: u.username,
  role: u.role,
  credits: u.credits,
  createdAt: u.createdAt,
});

/** 用于抵御用户名枚举的计时攻击：用户不存在时也做一次 scrypt */
let dummyHash: Promise<string> | null = null;

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly log = new Logger('Auth');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly billing: BillingService,
    private readonly invites: InviteService,
  ) {}

  /** 启动时确保有一个管理员 */
  async onApplicationBootstrap() {
    const admins = await this.users.countBy({ role: 'admin' });
    if (admins > 0) return;
    const password = this.cfg.adminPassword || randomBytes(9).toString('base64url');
    const existing = await this.users.findOneBy({ username: this.cfg.adminUsername });
    if (existing) {
      existing.role = 'admin';
      await this.users.save(existing);
      this.log.warn(`已把现有用户 ${existing.username} 提升为管理员`);
      return;
    }
    await this.users.save(
      this.users.create({
        username: this.cfg.adminUsername,
        passwordHash: await hashPassword(password),
        role: 'admin',
        credits: 0,
      }),
    );
    if (this.cfg.adminPassword) this.log.log(`已创建管理员 ${this.cfg.adminUsername}`);
    else this.log.warn(`已创建管理员 ${this.cfg.adminUsername}，初始密码：${password}（请登录后台尽快修改）`);
  }

  private async issue(user: User) {
    const token = await this.jwt.signAsync({ sub: user.id, ver: user.tokenVersion });
    return { token, user: toPublicUser(user) };
  }

  async register(username: string, password: string, inviteToken: string) {
    if (!this.cfg.allowRegister) throw new ForbiddenException('当前未开放注册，请联系管理员开通账号');
    if (await this.users.existsBy({ username })) throw new ConflictException('用户名已被占用');
    const passwordHash = await hashPassword(password);
    return this.ds.transaction(async (manager) => {
      const invite = await this.invites.consume(inviteToken, manager);
      const users = manager.getRepository(User);
      // 邀请带组织时注册后直接加入
      let user = users.create({ username, passwordHash, role: 'user', credits: 0, orgId: invite.orgId, lastLoginAt: new Date() });
      try {
        user = await users.save(user);
      } catch {
        throw new ConflictException('用户名已被占用');
      }
      if (invite.credits > 0) {
        user.credits = this.billing.adjust(user.id, invite.credits, 'register', null, '邀请注册赠送');
      }
      return this.issue(user);
    });
  }

  async login(username: string, password: string) {
    const user = await this.users.findOneBy({ username });
    if (!user) {
      dummyHash ??= hashPassword('dummy-password');
      await verifyPassword(password, await dummyHash);
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (!(await verifyPassword(password, user.passwordHash))) throw new UnauthorizedException('用户名或密码错误');
    if (user.disabled) throw new ForbiddenException('账号已被停用');
    user.lastLoginAt = new Date();
    await this.users.update(user.id, { lastLoginAt: user.lastLoginAt });
    return this.issue(user);
  }

  /** 当前用户，多一个所属组织 */
  async me(userId: number): Promise<PublicUser & { org: { id: number; name: string } | null }> {
    const user = await this.users.findOneByOrFail({ id: userId });
    const org = user.orgId === null ? null : await this.ds.getRepository(Org).findOneBy({ id: user.orgId });
    return { ...toPublicUser(user), org: org ? { id: org.id, name: org.name } : null };
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    const user = await this.users.findOneByOrFail({ id: userId });
    if (!(await verifyPassword(oldPassword, user.passwordHash))) throw new BadRequestException('原密码错误');
    user.passwordHash = await hashPassword(newPassword);
    user.tokenVersion += 1;
    await this.users.save(user);
    return this.issue(user);
  }
}
