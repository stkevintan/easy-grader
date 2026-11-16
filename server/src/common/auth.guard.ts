import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { User } from '../entities';

export interface AuthUser {
  id: number;
  username: string;
  role: 'user' | 'admin';
}

export interface JwtPayload {
  sub: number;
  ver: number;
}

const PUBLIC_KEY = 'isPublic';
const ADMIN_KEY = 'isAdmin';

/** 不需要登录的接口 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** 仅管理员 */
export const AdminOnly = () => SetMetadata(ADMIN_KEY, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

/**
 * 全局鉴权：Bearer JWT，每次请求都回表校验用户状态，
 * 这样禁用账号、改密码（tokenVersion+1）可以立即让旧令牌失效。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException('请先登录');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user || user.tokenVersion !== payload.ver) throw new UnauthorizedException('登录已失效，请重新登录');
    if (user.disabled) throw new ForbiddenException('账号已被停用');

    req.user = { id: user.id, username: user.username, role: user.role };
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_KEY, targets) && user.role !== 'admin') {
      throw new ForbiddenException('需要管理员权限');
    }
    return true;
  }
}
