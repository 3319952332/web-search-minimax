# dsh-web-search-minimax

DSH 的 `ctx.web` 搜索提供方插件，直连 MiniMax coding-plan 搜索接口
（`POST {baseURL}/v1/coding_plan/search`）。

它复用了官方 `minimax-coding-plan-mcp` 的 `web_search` 工具所调用的同一端点，
直接提交查询并返回有机搜索结果，不经过模型中介，因此没有"是否真的在搜索"的合规问题，
延迟约 1 秒。

## 功能

- 以 `minimax-coding-plan` 作为 provider id 注册到 `ctx.web` 搜索提供方。
- 调用 MiniMax coding-plan 直接搜索接口，返回去重后的结果源列表。
- 密钥通过 DSH credentials 服务或环境变量解析，从不硬编码。
- 所有携带凭据的请求拒绝 HTTP 重定向（防止凭据被转发到其它来源）。

## 安装

通过 git 安装到 DSH 的插件目录：

```sh
# 以 pnpm 为例，将本仓库作为依赖安装
pnpm add -D github:<owner>/dsh-web-search-minimax
```

或直接放到 DSH 插件目录（`~/.dsh/plugins/dsh-web-search-minimax`）。

## 配置

设置命名空间：`web-search-minimax`。

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `apiKey` | string（secret） | 可选的明文密钥；为空时走凭据解析。 |
| `apiKeyEnv` | string（credential-ref） | 凭据引用，默认 `MINIMAX_CN_API_KEY`。 |
| `baseURL` | string | 接口基地址，默认 `https://api.minimaxi.com`。 |

环境变量：

- `MINIMAX_CN_API_KEY`：MiniMax coding-plan 密钥（`sk-cp-...`）。
- `MINIMAX_SEARCH_BASE_URL`：覆盖接口基地址。

密钥解析优先级：`apiKey`（明文）→ credentials 服务 → 启动环境变量。

## 工作原理

每次搜索：

1. 读取当前配置，解析出密钥与基地址。
2. `POST {baseURL}/v1/coding_plan/search`，请求体 `{ "q": "<query>" }`，
   携带 `Authorization: Bearer <key>`。
3. 解析响应的 `organic` 结果列表，去重后归一化为 `{ sources, truncated }`。

## 网页设置卡片补丁（可选）

DSH 网页 GUI 的「设置 > 插件 > 插件配置」里，搜索卡片编译在
`@deepseek-ai/dsh-client-ui-settings-plugins`（npx 安装包）中，原版只内置 DeepSeek 卡片。

给 MiniMax 增加配置卡片需要给这个发布包打文本补丁。`patches/` 下两个脚本：

| 脚本 | 作用 | 适用版本 |
| --- | --- | --- |
| `apply-minimax-search-card.ps1` | 给前端 bundle 增加卡片 | rc.6 / rc.7+（写法不同，见下） |
| `apply-minimax-settings-exposure.ps1` | 把命名空间加入后端白名单 | **仅 rc.6**（rc.7+ 已自动暴露） |

> **版本注意**：
> - **rc.7+**：settings 命名空间由 `installSettingsSection` 自动暴露，不再需要白名单补丁。
>   卡片 slot 从 `list`+`id` 改为 `keyed`+`key`。
>   当前 `apply-minimax-search-card.ps1` **已按 rc.7 写法修改**（`key: MINIMAX_SEARCH_NS`）。
> - **rc.6**：需要两个补丁都跑，卡片 slot 用 `id`（上一个 git commit 的版本）。

### 用法

```powershell
# 先启动过一次 dsh web（让 npx 缓存里出现对应安装包）
powershell -NoProfile -ExecutionPolicy Bypass -File patches/apply-minimax-search-card.ps1
# rc.6 还需要：
# powershell -NoProfile -ExecutionPolicy Bypass -File patches/apply-minimax-settings-exposure.ps1
# 刷新浏览器即可在 设置 > 插件 > 插件配置 看到卡片
```

### 注意

- **平台**：脚本是 PowerShell（Windows）。补丁文本本身跨平台，但脚本里"定位 npx
  缓存 + 扫描运行进程"用了 WMI、`LOCALAPPDATA` 等 Windows 专属能力，换 Linux/macOS
  需改写定位逻辑（可改成 Node 脚本用 `npm config get cache` 定位）。
- **重装会还原**：`npx --yes @deepseek-ai/dsh web` 重装会覆盖发布包，补丁丢失，
  重跑脚本即可（幂等，已打补丁自动跳过）。
- **版本失配**：rc 版本变化导致替换文本不匹配时，脚本会报「未匹配」并拒绝写入，
  需按脚本内注释更新替换文本。
- **非必需**：如果不需要 GUI 卡片，可直接在 `settings.yaml` 里写
  `web-search-minimax:` 段（`apiKey`/`apiKeyEnv`/`baseURL`）完成配置，无需补丁。
- **本地备份**：`local-backup/` 目录下保存了本机 cordis.patch.yml 与手动插件副本，
  供 npx 更新后恢复参考。

## License

MIT