# dsh-web-search-minimax

DSH 的 `ctx.web` 搜索提供方插件，直连 MiniMax coding-plan 搜索接口
（`POST {baseURL}/v1/coding_plan/search`）。

它复用了官方 `minimax-coding-plan-mcp` 的 `web_search` 工具所调用的同一端点，
直接提交查询并返回有机搜索结果，不经过模型中介，因此没有“是否真的在搜索”的合规问题，
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

## License

MIT
