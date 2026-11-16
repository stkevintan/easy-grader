import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

const TTL_MS = 60_000;
/** 防止被刷爆内存：同时有效的交接码上限，超出时先丢最早的 */
const MAX_PENDING = 10_000;

const hash = (code: string) => createHash('sha256').update(code).digest('hex');

interface Pending {
  userId: number;
  /** 签发时的 tokenVersion：期间改了密码或被停用，码作废 */
  tokenVersion: number;
  expiresAt: number;
}

/**
 * 从扩展打开控制台时免登录：扩展用自己的登录换一个一次性交接码，控制台再用码换自己的 JWT。
 * 码只能用一次、60 秒过期，内存里只存它的哈希。单实例部署够用；服务重启后码丢失，再点一次即可。
 */
@Injectable()
export class HandoffService {
  private readonly pending = new Map<string, Pending>();

  /** 当前时间；测试里可以替换 */
  now(): number {
    return Date.now();
  }

  issue(userId: number, tokenVersion: number): { code: string; expiresIn: number } {
    this.sweep();
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const code = `EGH-${randomBytes(24).toString('base64url')}`;
    this.pending.set(hash(code), { userId, tokenVersion, expiresAt: this.now() + TTL_MS });
    return { code, expiresIn: TTL_MS / 1000 };
  }

  /** 取出并作废；无效、过期、已用过都返回 null */
  take(code: string): Pending | null {
    const key = hash(code.trim());
    const p = this.pending.get(key);
    if (!p) return null;
    this.pending.delete(key);
    return p.expiresAt > this.now() ? p : null;
  }

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= t) this.pending.delete(k);
  }
}
