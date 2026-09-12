Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(244, 247, 244))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(32, 83, 63)), 14
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$pointsTop = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 128,35),(New-Object System.Drawing.Point 211,78),(New-Object System.Drawing.Point 128,124),(New-Object System.Drawing.Point 45,78),(New-Object System.Drawing.Point 128,35))
$graphics.DrawLines($pen, $pointsTop)
$graphics.DrawLine($pen, 45,78,45,173)
$graphics.DrawLine($pen, 45,173,128,221)
$graphics.DrawLine($pen, 128,221,211,173)
$graphics.DrawLine($pen, 211,173,211,78)
$graphics.DrawLine($pen, 128,124,128,221)
$graphics.DrawLine($pen, 45,78,128,124)
$graphics.DrawLine($pen, 211,78,128,124)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [System.IO.File]::Create((Join-Path $PSScriptRoot '3Dcity.ico'))
$icon.Save($stream)
$stream.Close()
$icon.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
