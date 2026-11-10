import { ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';

const BUCKET_KEY = 'throttleBucket';
export type ThrottleBucket = 'auth' | 'judge';

/** 给路由加一个额外的限流桶（阈值来自配置 RATE_LIMIT_AUTH / RATE_LIMIT_JUDGE） */
export const ThrottleBucket = (bucket: ThrottleBucket) => SetMetadata(BUCKET_KEY, bucket);

/**
 * 登录后按用户限流，未登录按 IP 限流（AuthGuard 先于本守卫执行）。
 * default 桶作用于所有路由；auth / judge 桶只作用于标记了对应 ThrottleBucket 的路由。
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`;
  }

  protected async handleRequest(r: ThrottlerRequest): Promise<boolean> {
    const name = r.throttler.name ?? 'default';
    if (name !== 'default') {
      const bucket = this.bucketOf(r.context);
      if (bucket !== name) return true;
    }
    return super.handleRequest(r);
  }

  private bucketOf(ctx: ExecutionContext): ThrottleBucket | undefined {
    return this.reflector.getAllAndOverride<ThrottleBucket>(BUCKET_KEY, [ctx.getHandler(), ctx.getClass()]);
  }
}
