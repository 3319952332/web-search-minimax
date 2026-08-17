# =====================================================================
#  apply-minimax-settings-exposure.ps1
#
#  让 DSH 的 settings API 暴露 web-search-minimax 命名空间。
#
#  背景：DSH 的 /api/settings.* 只对白名单命名空间放行（describe 会过滤、
#  写入会返回 settings-not-exposed）。白名单 WEB_SETTINGS_NAMESPACES 写在
#  npx 安装包 @deepseek-ai/dsh-host-apiproxy 的 lib 里，官方只内置了
#  'web-search-deepseek'，没有 'web-search-minimax'，所以 MiniMax 插件的
#  配置卡片永远拿不到命名空间。`npx --yes @deepseek-ai/dsh web` 重装后
#  本补丁会被还原，重跑本脚本即可恢复（已打补丁时自动跳过）。
#
#  用法：  powershell -NoProfile -ExecutionPolicy Bypass -File 本脚本
#  生效：  打补丁后需重启 DSH（重启DSH 用 Desktop\dsh\restart-dsh-web.cmd）
#  注意：  本脚本须保持 UTF-8 with BOM 编码（PowerShell 5.1 兼容）。
# =====================================================================
$ErrorActionPreference = 'Stop'

function Find-ApiProxyIndex {
  $candidate = $null
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dsh.*bin\.js.*\bweb\b' } |
    ForEach-Object {
      if ($_.CommandLine -match '([A-Za-z]:\\[^"]*?_npx\\[^"]*?\\node_modules)\\[^"]*?\\dsh\\lib\\bin\.js') {
        $candidate = Join-Path $Matches[1] '@deepseek-ai\dsh-host-apiproxy\lib'
      }
    }
  if ($candidate -and (Test-Path $candidate)) { return $candidate }
  $homeNpx = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  if (Test-Path $homeNpx) {
    $found = Get-ChildItem $homeNpx -Recurse -Directory -Filter 'dsh-host-apiproxy' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return Join-Path $found.FullName 'lib' }
  }
  throw '找不到 @deepseek-ai/dsh-host-apiproxy/lib，请先启动过 dsh web。'
}

$lib = Find-ApiProxyIndex
$indexFile = Join-Path $lib 'index.js'
$typesFile = Join-Path $lib 'types\api-proxy.js'
Write-Host "apiproxy lib: $lib"

$indexText = [System.IO.File]::ReadAllText($indexFile, [System.Text.Encoding]::UTF8)
if ($indexText.Contains('"web-search-minimax"')) {
  Write-Host '白名单补丁已存在，跳过。'
  exit 0
}

$changed = @()
# index.js：多行数组形式
$oldIndex = "	`"web-search-deepseek`"`n];"
$newIndex = "	`"web-search-deepseek`",`n	`"web-search-minimax`"`n];"
if ($indexText.Contains($oldIndex)) {
  $indexText = $indexText.Replace($oldIndex, $newIndex)
  [System.IO.File]::WriteAllText($indexFile, $indexText, (New-Object System.Text.UTF8Encoding($false)))
  $changed += 'index.js'
} else {
  Write-Host "警告：index.js 未找到预期片段，未写入。" -ForegroundColor Yellow
}

if (Test-Path $typesFile) {
  $typesText = [System.IO.File]::ReadAllText($typesFile, [System.Text.Encoding]::UTF8)
  $oldTypes = "'web-search-deepseek',"
  if ($typesText.Contains($oldTypes) -and -not $typesText.Contains("'web-search-minimax'")) {
    $typesText = $typesText.Replace($oldTypes, "'web-search-deepseek', 'web-search-minimax',")
    [System.IO.File]::WriteAllText($typesFile, $typesText, (New-Object System.Text.UTF8Encoding($false)))
    $changed += 'types/api-proxy.js'
  }
}

if ($changed.Count -eq 0) {
  Write-Host "没有文件被修改（版本可能已变化），请人工检查。" -ForegroundColor Yellow
  exit 2
}

Write-Host ("已打补丁: " + ($changed -join ', '))
Write-Host "请用 Desktop\dsh\restart-dsh-web.cmd 重启 DSH 后，在 设置 > 插件 > 插件配置 查看 MiniMax 网页搜索卡片。"
