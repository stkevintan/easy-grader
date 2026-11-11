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
import { ManagementUnit, UnitMembership, UnitRole, User } from '../entities';

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
const UNIT_KEY = 'unitAccess';

export const UnitAccess = (roles: UnitRole[] = ['viewer', 'grader', 'manager', 'owner']) => SetMetadata(UNIT_KEY, roles);

/** 不需要登录的接口 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** 仅管理员 */
export const AdminOnly = () => SetMetadata(ADMIN_KEY, true);

export const CurrentUnit = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): UnitContext => ctx.switchToHttp().getRequest().unit,
);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

export interface UnitContext {
  id: number;
  role: UnitRole;
}

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
    const unitRoles = this.reflector.getAllAndOverride<UnitRole[]>(UNIT_KEY, targets);
    if (unitRoles) {
      const routeUnitId = Number((req.params as { unitId?: string }).unitId);
      const requestedUnitId = Number(req.headers['x-unit-id'] || req.query.unitId || req.body?.unitId);
      let unitId = Number.isInteger(routeUnitId) && routeUnitId > 0 ? routeUnitId : requestedUnitId;
      if (!Number.isInteger(unitId) || unitId <= 0) {
        const personal = await this.users.manager.getRepository(UnitMembership).findOne({ where: { userId: user.id, role: 'owner' }, order: { id: 'ASC' } });
        unitId = personal?.unitId ?? 0;
      }
      if (!Number.isInteger(unitId) || unitId <= 0) throw new ForbiddenException('请指定管理单元');
      if (Number.isInteger(routeUnitId) && routeUnitId > 0 && Number.isInteger(requestedUnitId) && requestedUnitId > 0 && routeUnitId !== requestedUnitId) {
        throw new ForbiddenException('管理单元不一致');
      }
      const membership = await this.users.manager.getRepository(UnitMembership).findOneBy({ unitId, userId: user.id });
      const unit = await this.users.manager.getRepository(ManagementUnit).findOneBy({ id: unitId, enabled: true });
      if (!unit || !membership || !unitRoles.includes(membership.role)) throw new ForbiddenException('无权访问该管理单元');
      (req as Request & { unit?: { id: number; role: UnitRole } }).unit = { id: unitId, role: membership.role };
    }
    return true;
  }
}
