# Free Proxy Cloudflare Monitor

纯 Cloudflare Workers + D1 的免费代理聚合与可用性监控项目。

## 目标

- 聚合 WSAPI 与公开代理列表
- Cron 自动更新、去重并轮询检测
- 从 Cloudflare Worker 网络实际检测 HTTP/SOCKS5 节点
- D1 保存节点状态、延迟和运行历史
- 提供带认证的状态后台和手动刷新
- 不在本地运行服务、容器或中转
- API 密钥只使用 Worker Secret

## 进度

- [x] 创建隔离项目
- [x] 代理列表解析与去重
- [x] D1 数据模型
- [x] Cloudflare socket 健康检测
- [x] Cron 自动更新（每 5 分钟触发器已通过线上 scheduled 日志验证）
- [x] 后台页面与认证
- [x] 测试、类型检查和依赖审计
- [x] Cloudflare 部署
- [x] 线上手动刷新、节点检测和后台页面验证
- [x] `/socks5` 和 `/http` 纯文本节点接口，供 NoTrack 等客户端读取

后台密码和 WSAPI Key 均保存在 Cloudflare Worker Secret，不写入源码、README 或 D1。
列表接口使用同一组 Basic Auth：用户名 `admin`，请求头为 `Authorization: Basic <base64(admin:密码)>`。
列表只返回最近 45 分钟内通过真实转发验证的节点，每行一个 `host:port`，适合 NoTrack 的代理列表配置。

## 数据源

- 用户提供的 `wsapi.top` API
- `monosans/proxy-list` SOCKS5 列表
- `relayglass/free-proxy-list` SOCKS5 列表
- `proxifly/free-proxy-list` HTTP 与 SOCKS5 分表

每次任务从 5 个来源各轮转抽样最多 100 条，去重后写入 D1。数据库硬上限为 500 条，优先保留最近验证可用的节点，其次保留待检测节点；后台默认只显示当前可用节点。检测时优先复检超过 30 分钟的可用节点，再检查新候选，并保持最多 5 个并发 socket。

## 可用性定义

节点只有在 Cloudflare Worker 中完成以下完整流程才会标记为 `alive`：

1. 建立到代理节点的 TCP 连接；
2. 完成 HTTP 代理请求或 SOCKS5 握手；
3. 通过代理访问固定 `httpbingo.org` nonce 探测地址，收到 HTTP 200 且响应正文回显 nonce。

检测目标固定，客户端不能指定目标地址，本项目不提供转发代理接口。免费节点可能随时失效；状态仅表示最近一次检测结果，不构成可用性保证。

## 本地验证

```bash
npm run typecheck
npm test
npm audit --audit-level=low
npx wrangler deploy --dry-run
```

本项目不会在本地启动服务、容器或中转；本地目录仅包含源代码、依赖与测试产物。

## 部署

将 `wrangler.jsonc` 中的 Worker 和 D1 名称替换为自己的资源后，使用 Wrangler 部署。后台密码和 WSAPI Key 必须通过 Worker Secret 设置，不能提交到 Git。
