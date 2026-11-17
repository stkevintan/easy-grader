import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig, type ModelConfig } from '../config';

/** 探测用的小图：红底白色「7」，足够任何一个视觉模型分出有没有读图能力 */
const PROBE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAApElEQVR42u3XSREAIAwEwSiJfym4Age8OELRW6OgfxstU5MCASBAgAABAgQIkAABAgQIECBAgAQIUGmgfnWAAAECBAgQIECAAAEC9CfQvgABAgQIECBAgAABAgQIUM1bCwgQIECAAAECBAgQIECAnFVAgAABAgQIECBAgAABAgQIECBAgAABAvQm0PkAAQIECBAgQIAACRAgQIAAAQIESIAALWsA3DcBO7AI/gAAAAAASUVORK5CYII=';

export interface VisionProbeResult {
  ok: boolean;
  /** 失败原因，直接展示给管理员 */
  error: string;
  latencyMs: number;
}

/**
 * 判断一套模型配置能不能读图：发一张已知内容的小图，让它说图里的数字。
 * 不读图的模型要么直接 400（不认识 image_url），要么答非所问。
 */
@Injectable()
export class VisionService {
  private readonly log = new Logger('Vision');

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async probe(m: ModelConfig): Promise<VisionProbeResult> {
    const started = Date.now();
    const fail = (error: string): VisionProbeResult => ({ ok: false, error, latencyMs: Date.now() - started });
    if (!m.apiKey) return fail('没有 API Key');
    if (!m.baseUrl) return fail('没有接口地址');
    if (!m.name) return fail('没有模型名');

    const url = `${m.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model: m.name,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片里的数字是几？只回答那个数字。' },
            { type: 'image_url', image_url: { url: PROBE_IMAGE } },
          ],
        },
      ],
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(m.timeoutMs, 60_000));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${m.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // 400 里常见 "image_url is not supported" / "content must be text"
        return fail(`接口返回 ${res.status}：${text.slice(0, 200)}`);
      }
      let reply = '';
      try {
        const data = JSON.parse(text) as {
          choices?: { message?: { content?: string | { type?: string; text?: string }[] } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        // 和评分时一样：content 可能是字符串，也可能是分段数组；不拿 reasoning 顶替正文
        if (typeof content === 'string') reply = content.trim();
        else if (Array.isArray(content)) {
          reply = content
            .map((part) => (typeof part === 'string' ? part : (part?.type === 'text' ? part.text ?? '' : '')))
            .join('')
            .trim();
        }
      } catch {
        return fail(`返回的不是 JSON：${text.slice(0, 120)}`);
      }
      if (!reply) return fail('模型没有返回内容，可能没读图或输出被截断');
      if (!reply.includes('7')) {
        return fail(`模型看到了图但答案不对（回答「${reply.slice(0, 60)}」），可能只支持文字`);
      }
      return { ok: true, error: '', latencyMs: Date.now() - started };
    } catch (e) {
      const err = e as Error;
      const msg = err.name === 'AbortError' ? '请求超时' : err.message;
      this.log.warn(`视觉探测失败：${msg}`);
      return fail(msg);
    } finally {
      clearTimeout(timer);
    }
  }
}
