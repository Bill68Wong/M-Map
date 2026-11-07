# MUST登校 · 每日备份脚本（db/backup.ps1）
# 从 Supabase 云库导出完整备份到本地 backups/ 目录，保留最近 30 份
# 手动运行：npm run db:backup
# 自动运行：Windows 任务计划每日 09:00（首次需手动注册，见 docs/spec.md 第 8 节）

$ErrorActionPreference = "Stop"

# 加载 .env 中的 DATABASE_URL
$envFile = Join-Path $PSScriptRoot "..\.env"
if (-Not (Test-Path $envFile)) {
    Write-Host "[backup] 未找到 .env，无法获取云库连接串" -ForegroundColor Red
    exit 1
}
$connStr = (Get-Content $envFile | Select-String "^DATABASE_URL=(.+)$").Matches[0].Groups[1].Value
if (-Not $connStr) {
    Write-Host "[backup] .env 中没有 DATABASE_URL" -ForegroundColor Red
    exit 1
}

$backupDir = Join-Path $PSScriptRoot "..\backups"
if (-Not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

$date = Get-Date -Format "yyyy-MM-dd"
$outFile = Join-Path $backupDir "$date.dump"

# 解析 pg_dump：PATH 上没有时按常见安装位置探测（本机 PostgreSQL 装在 D:\Development\Databases）
$pgDump = $null
if ($env:PG_DUMP_PATH -and (Test-Path $env:PG_DUMP_PATH)) {
    $pgDump = $env:PG_DUMP_PATH
} else {
    $cmd = Get-Command pg_dump -ErrorAction SilentlyContinue
    if ($cmd) { $pgDump = $cmd.Source }
}
if (-Not $pgDump) {
    foreach ($p in @(
        "D:\Development\Databases\PostgreSQL\bin\pg_dump.exe",
        "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe",
        "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe",
        "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe",
        "C:\Program Files\PostgreSQL\15\bin\pg_dump.exe"
    )) {
        if (Test-Path $p) { $pgDump = $p; break }
    }
}
if (-Not $pgDump) {
    Write-Host "[backup] 找不到 pg_dump。请安装 PostgreSQL 客户端，或设置 PG_DUMP_PATH 环境变量" -ForegroundColor Red
    exit 1
}

Write-Host "[backup] 开始备份 Supabase -> $outFile（pg_dump: $pgDump）"
& $pgDump --no-owner --no-privileges --format=custom --dbname=$connStr --file=$outFile

if ($LASTEXITCODE -ne 0) {
    Write-Host "[backup] pg_dump 失败（退出码 $LASTEXITCODE）。请确认 pg_dump 已安装且版本 >= 云库版本" -ForegroundColor Red
    exit 1
}

$size = [math]::Round((Get-Item $outFile).Length / 1KB, 1)
Write-Host "[backup] 完成：$outFile（${size} KB）" -ForegroundColor Green

# 清理旧备份：只删「超出最近 30 份」且「超过 30 天」的 dump。
# 原实现只按 30 天删，会把仅有的几份历史基线（如 2026-09-15）一并删掉，
# 而它们往往是出事时唯一可回退的早期还原点 —— 备份脚本不该主动销毁还原点。
$allDumps = Get-ChildItem $backupDir -Filter "*.dump" | Sort-Object LastWriteTime -Descending
$stale = $allDumps | Select-Object -Skip 30 | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) }
$stale | Remove-Item -Confirm:$false
Write-Host "[backup] 旧备份清理完成（保留最近 30 份，且不删 30 天内的）"
