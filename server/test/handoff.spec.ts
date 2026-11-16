import { HandoffService } from '../src/auth/handoff.service';

describe('HandoffService', () => {
  it('60 秒内能用一次，过期或用过之后都失效', () => {
    const svc = new HandoffService();
    let t = 1_000_000;
    svc.now = () => t;
    const a = svc.issue(7, 3);
    expect(a.expiresIn).toBe(60);
    expect(svc.take(a.code)).toMatchObject({ userId: 7, tokenVersion: 3 });
    expect(svc.take(a.code)).toBeNull();

    const b = svc.issue(7, 3);
    t += 59_999;
    expect(svc.take(b.code)).not.toBeNull();

    const c = svc.issue(7, 3);
    t += 60_000;
    expect(svc.take(c.code)).toBeNull();
  });

  it('码之间互不相同，取码前后的空白会被去掉', () => {
    const svc = new HandoffService();
    const a = svc.issue(1, 0);
    const b = svc.issue(1, 0);
    expect(a.code).not.toBe(b.code);
    expect(svc.take(`  ${a.code}\n`)).not.toBeNull();
  });
});
