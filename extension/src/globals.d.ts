/**
 * 构建期常量，由 build.mjs 通过 esbuild define 注入：
 *   pnpm build        → 发布版：__DEV__ = false，服务端固定为 __SERVER_URL__
 *   pnpm build:dev    → 开发版：__DEV__ = true，可在 popup 设置里改服务端地址
 *
 * 必须直接写 `if (__DEV__)`，不要先赋给别的变量再用：esbuild 只在条件本身是
 * 被 define 替换的字面量时才能把发布版里的开发分支整段删掉。
 */
declare const __DEV__: boolean;
declare const __SERVER_URL__: string;
