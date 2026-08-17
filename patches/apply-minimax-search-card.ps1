# =====================================================================
#  apply-minimax-search-card.ps1
#
#  在 DSH 插件栏（设置 > 插件 > 插件配置）为 MiniMax 网页搜索增加配置卡片：
#  可编辑「接口地址 (baseURL)」和「API Key」，保存即生效。
#
#  背景：`dsh web` 从 npx 缓存安装的
#  @deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js 是发布产物，
#  `npx --yes @deepseek-ai/dsh web` 重装后会被还原。本脚本用文本替换把
#  MiniMax 卡片补丁重新打回该 bundle，可重复运行（已打补丁时自动跳过）。
#
#  用法：  powershell -NoProfile -ExecutionPolicy Bypass -File 本脚本
#  生效：  打补丁后刷新浏览器页面即可（bundle 按请求读盘，无需重启服务）。
# =====================================================================
$ErrorActionPreference = 'Stop'

# 定位 npx 缓存里的 client bundle：优先取正在运行的 dsh web 进程所引用的包路径。
function Find-ClientBundle {
  $candidate = $null
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dsh.*bin\.js.*\bweb\b' } |
    ForEach-Object {
      if ($_.CommandLine -match '([A-Za-z]:\\[^"]*?_npx\\[^"]*?\\node_modules)\\[^"]*?\\dsh\\lib\\bin\.js') {
        $candidate = Join-Path $Matches[1] '@deepseek-ai\dsh-client-ui-settings-plugins\lib\client.js'
      }
    }
  if ($candidate -and (Test-Path $candidate)) { return $candidate }
  # 兜底：搜索常见 npx 缓存目录
  $homeNpx = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  if (Test-Path $homeNpx) {
    $found = Get-ChildItem $homeNpx -Recurse -Filter client.js -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'dsh-client-ui-settings-plugins' } |
      Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  throw '找不到 @deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js，请先启动过 dsh web。'
}

$path = Find-ClientBundle
Write-Host "bundle: $path"

$text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
if ($text.Contains('function MiniMaxSearchCard')) {
  Write-Host 'MiniMax 卡片补丁已存在，跳过。'
  exit 0
}

# 每项：@{ old = <原样文本>; new = <替换文本> }（tab 缩进与发布文件一致，LF 行尾）
$steps = @(
  @{
    old = "		//#endregion`n		//#region lib/types/client/card-form.js"
    new = @'
		/**
		* Render the MiniMax search card. Same shape as the DeepSeek card minus the
		* per-request search bound: the MiniMax coding-plan direct search API has no
		* `max_uses` knob, so the card carries only the key and the endpoint.
		* @param props - locale copy, the card snapshot, and its form actions.
		* @returns the card.
		*/
		function MiniMaxSearchCard(props) {
			const { t } = props;
			const state = props.useMinimaxSearchCard((snapshot) => snapshot);
			const disabled = !state.writable;
			return (0, react_jsx_runtime.jsxs)(PluginCard, {
				t,
				titleKey: "minimaxSearchTitle",
				descriptionKey: "minimaxSearchDescription",
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					(0, react_jsx_runtime.jsx)(SecretField, {
						id: "plugin-config-minimax-search-key",
						label: t("minimaxSearchApiKey"),
						hint: t("minimaxSearchApiKeyHint"),
						disabled: !state.apiKeyWritable,
						text: state.apiKey.text,
						configured: state.apiKeyConfigured,
						stateLabel: state.apiKeyConfigured ? t("minimaxSearchApiKeySet") : t("minimaxSearchApiKeyUnset"),
						onEdit: (text) => {
							props.edit("apiKey", text);
						}
					}),
					(0, react_jsx_runtime.jsx)(ValueField, {
						id: "plugin-config-minimax-search-endpoint",
						label: t("minimaxSearchBaseUrl"),
						hint: t("minimaxSearchBaseUrlHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidNumber"),
						disabled,
						...state.baseURL,
						onEdit: (text) => {
							props.edit("baseURL", text);
						},
						onReset: () => {
							props.resetField("baseURL");
						}
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/card-form.js
'@
  },
  @{
    old = "		const DEFAULT_API_KEY_REF = `"DEEPSEEK_API_KEY`";"
    new = @'
		const DEFAULT_API_KEY_REF = "DEEPSEEK_API_KEY";
		/** Namespace of the MiniMax coding-plan search provider. */
		const MINIMAX_SEARCH_NS = "web-search-minimax";
		/** Credential reference the MiniMax provider resolves when the section names none. */
		const MINIMAX_DEFAULT_API_KEY_REF = "MINIMAX_CN_API_KEY";
'@
  },
  @{
    old = "			store;`n			credential = {"
    new = @'
			store;
			defaultKeyRef;
			hookName;
			fields;
			credential = {
'@
  },
  @{
    old = "			constructor(scope, api) {`n				this.scope = scope;`n				this.api = api;`n				this.form = new CardForm(scope, [textField(`"baseURL`"), numberField(`"maxUses`")], [{"
    new = @'
			constructor(scope, api, spec = {}) {
				this.scope = scope;
				this.api = api;
				this.defaultKeyRef = spec.defaultKeyRef ?? DEFAULT_API_KEY_REF;
				this.hookName = spec.hookName ?? "webSearchCard";
				this.fields = spec.fields ?? [textField("baseURL"), numberField("maxUses")];
				this.form = new CardForm(scope, this.fields, [{
'@
  },
  @{
    old = "					maxUses: this.form.field(`"maxUses`"),"
    new = "					maxUses: this.fields.some((f) => f.field === `"maxUses`") ? this.form.field(`"maxUses`") : void 0,"
  },
  @{
    old = "				const ref = refOf(this.scope.getSnapshot());"
    new = "				const ref = refOf(this.scope.getSnapshot(), this.defaultKeyRef);"
  },
  @{
    old = "				if (!response.result.ok || ref !== refOf(this.scope.getSnapshot())) return;"
    new = "				if (!response.result.ok || ref !== refOf(this.scope.getSnapshot(), this.defaultKeyRef)) return;"
  },
  @{
    old = "					hooks: { webSearchCard: this.store },"
    new = "					hooks: { [this.hookName]: this.store },"
  },
  @{
    old = "						ref: refOf(this.scope.getSnapshot()),"
    new = "						ref: refOf(this.scope.getSnapshot(), this.defaultKeyRef),"
  },
  @{
    old = "		function refOf(snapshot) {`n			const declared = snapshot.value?.apiKeyEnv;`n			return declared !== void 0 && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;`n		}"
    new = @'
		function refOf(snapshot, defaultRef) {
			const declared = snapshot.value?.apiKeyEnv;
			return declared !== void 0 && declared.length > 0 ? declared : defaultRef;
		}
'@
  },
  @{
    old = "			webSearchMaxUsesHint: `"How many times one request may search before it must answer.`"`n		};"
    new = @'
			webSearchMaxUsesHint: "How many times one request may search before it must answer.",
			minimaxSearchTitle: "MiniMax web search",
			minimaxSearchDescription: "The MiniMax coding-plan search provider.",
			minimaxSearchApiKey: "API key",
			minimaxSearchApiKeyHint: "Stored outside the settings file. Leave blank to keep the current key.",
			minimaxSearchApiKeySet: "A key is configured.",
			minimaxSearchApiKeyUnset: "No key is configured; search is unavailable until one is.",
			minimaxSearchBaseUrl: "Endpoint",
			minimaxSearchBaseUrlHint: "Leave blank to use the provider default."
		};
'@
  },
  @{
    old = "			webSearchMaxUsesHint: `"一次请求在必须作答前最多可以搜索多少次。`"`n		};"
    new = @'
			webSearchMaxUsesHint: "一次请求在必须作答前最多可以搜索多少次。",
			minimaxSearchTitle: "MiniMax 网页搜索",
			minimaxSearchDescription: "MiniMax coding-plan 搜索提供方。",
			minimaxSearchApiKey: "API Key",
			minimaxSearchApiKeyHint: "不写入设置文件。留空表示保持当前密钥。",
			minimaxSearchApiKeySet: "已配置密钥。",
			minimaxSearchApiKeyUnset: "未配置密钥；配置之前搜索不可用。",
			minimaxSearchBaseUrl: "接口地址",
			minimaxSearchBaseUrlHint: "留空则使用提供方默认地址。"
		};
'@
  },
  @{
    old = "			const webSearch = new WebSearchCardController(ctx.settingsScope.bind({ namespace: WEB_SEARCH_NS }), api);`n			ctx.effect(() => ctx.remote.`$on(`"credentials/updated`", (ref) => {`n				webSearch.refreshCredential(ref);`n			}), `"ui-settings-plugins: credential invalidations`");"
    new = @'
			const webSearch = new WebSearchCardController(ctx.settingsScope.bind({ namespace: WEB_SEARCH_NS }), api);
			const minimaxSearch = new WebSearchCardController(ctx.settingsScope.bind({ namespace: MINIMAX_SEARCH_NS }), api, {
				defaultKeyRef: MINIMAX_DEFAULT_API_KEY_REF,
				fields: [textField("baseURL")],
				hookName: "minimaxSearchCard"
			});
			ctx.effect(() => ctx.remote.$on("credentials/updated", (ref) => {
				webSearch.refreshCredential(ref);
				minimaxSearch.refreshCredential(ref);
			}), "ui-settings-plugins: credential invalidations");
'@
  },
  @{
    old = "				}, WebSearchCard);`n			});"
    new = @'
				}, WebSearchCard);
				yield ctx.slots.register({
					name: "settings.plugin.item",
					id: "web-search-minimax",
					order: 30,
					locale: NS,
					inject: () => minimaxSearch.inject()
				}, MiniMaxSearchCard);
			});
'@
  }
)

$applied = 0
$failed = @()
foreach ($step in $steps) {
  if ($text.Contains($step.old)) {
    $text = $text.Replace($step.old, $step.new)
    $applied++
  } else {
    $failed += ($step.old.Substring(0, [Math]::Min(60, $step.old.Length)) -replace "`r|`n", ' ')
  }
}

if ($failed.Count -gt 0) {
  Write-Host "警告：以下 $($failed.Count) 处未匹配（可能是版本已变化，未做任何写入）：" -ForegroundColor Yellow
  $failed | ForEach-Object { Write-Host "  - $_" }
  exit 2
}

[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已应用 $applied 处替换。刷新浏览器即可在 设置 > 插件 > 插件配置 看到「MiniMax 网页搜索」卡片。"
