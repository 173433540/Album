$ErrorActionPreference = "Stop"

$root = "C:\AI\PhotoAlbum"
$dist = "C:\AI\Album\Album"
$rcedit = "C:\AI\_tools\rcedit\rcedit.exe"

if (-not (Test-Path (Join-Path $root "node_modules\electron\dist\electron.exe"))) {
    throw "未找到 Electron，请先执行 npm install"
}

Write-Host "清理旧目录…"
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }

Write-Host "复制 Electron 运行时…"
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Copy-Item (Join-Path $root "node_modules\electron\dist\*") $dist -Recurse -Force

Rename-Item (Join-Path $dist "electron.exe") "Album.exe"
if (Test-Path (Join-Path $dist "resources\default_app.asar")) {
    Remove-Item (Join-Path $dist "resources\default_app.asar") -Force
}

$app = Join-Path $dist "resources\app"
New-Item -ItemType Directory -Path $app -Force | Out-Null
Copy-Item (Join-Path $root "main") (Join-Path $app "main") -Recurse -Force
Copy-Item (Join-Path $root "renderer") (Join-Path $app "renderer") -Recurse -Force
Copy-Item (Join-Path $root "assets") (Join-Path $app "assets") -Recurse -Force
Copy-Item (Join-Path $root "package.json") (Join-Path $app "package.json") -Force

Write-Host "写入图标与版本信息…"
$version = (Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
if (-not $version) { $version = "1.0.0" }
if (Test-Path $rcedit) {
    & $rcedit (Join-Path $dist "Album.exe") `
        --set-icon (Join-Path $root "assets\app.ico") `
        --set-version-string "ProductName" "Album" `
        --set-version-string "FileDescription" "Album - 本地图片相册" `
        --set-version-string "CompanyName" "Local" `
        --set-file-version $version `
        --set-product-version $version | Out-Null
} else {
    Write-Host "（未找到 rcedit，跳过图标写入）"
}

$exe = Join-Path $dist "Album.exe"
$bytes = (Get-ChildItem $dist -Recurse -File | Measure-Object -Property Length -Sum).Sum
$mb = [math]::Round($bytes / 1MB, 1)
Write-Host ("完成：" + $exe)
Write-Host ("大小：" + $mb + " MB")