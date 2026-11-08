$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = "AntiAlias"
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角黑底
$r = 56
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($size - $r, 0, $r, $r, 270, 90)
$path.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
$path.AddArc(0, $size - $r, $r, $r, 90, 90)
$path.CloseFigure()

$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(28,28,32), [System.Drawing.Color]::FromArgb(6,6,8), 60.0)
$g.FillPath($brush, $path)
$brush.Dispose()

# 白色相框
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(244,244,246), 9)
$pen.LineJoin = "Round"
$fr = New-Object System.Drawing.Rectangle(58, 68, 140, 118)
$g.DrawRectangle($pen, $fr)
$pen.Dispose()

# 山形
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(244,244,246))
$pts = @(
  (New-Object System.Drawing.Point(66, 178)),
  (New-Object System.Drawing.Point(112, 128)),
  (New-Object System.Drawing.Point(146, 162)),
  (New-Object System.Drawing.Point(166, 140)),
  (New-Object System.Drawing.Point(190, 178))
)
$g.FillPolygon($white, $pts)

# 太阳
$g.FillEllipse($white, 74, 88, 22, 22)
$white.Dispose()
$g.Dispose()

$png = New-Object System.IO.MemoryStream
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $png.ToArray()
$bmp.Dispose()

# 生成 ICO（单帧 PNG，256x256）
$ms = New-Object System.IO.MemoryStream
$bw = [System.IO.BinaryWriter]::new([System.IO.Stream]$ms)
$bw.Write([UInt16]0)      # reserved
$bw.Write([UInt16]1)      # type icon
$bw.Write([UInt16]1)      # count
$bw.Write([Byte]0)        # width 256
$bw.Write([Byte]0)        # height 256
$bw.Write([Byte]0)        # colors
$bw.Write([Byte]0)        # reserved
$bw.Write([UInt16]1)      # planes
$bw.Write([UInt16]32)     # bpp
$bw.Write([UInt32]$pngBytes.Length)
$bw.Write([UInt32]22)     # offset
$bw.Write($pngBytes)
$bw.Flush()

$outIco = "C:\AI\PhotoAlbum\assets\app.ico"
New-Item -ItemType Directory -Path (Split-Path $outIco) -Force | Out-Null
[System.IO.File]::WriteAllBytes($outIco, $ms.ToArray())
$ms.Dispose()
$png.Dispose()
Write-Output ("icon written: " + $outIco + " (" + (Get-Item $outIco).Length + " bytes)")

# 同时导出一张 PNG 预览
[System.IO.File]::WriteAllBytes("C:\AI\PhotoAlbum\assets\app-256.png", $pngBytes)