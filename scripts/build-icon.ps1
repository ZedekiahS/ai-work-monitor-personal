$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconDir = Join-Path $PSScriptRoot '../desktop/assets'
[IO.Directory]::CreateDirectory($iconDir) | Out-Null
$bitmap = New-Object Drawing.Bitmap 256,256
$g = [Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([Drawing.Color]::Transparent)
$shape = New-Object Drawing.Drawing2D.GraphicsPath
$shape.AddArc(8,8,88,88,180,90)
$shape.AddArc(160,8,88,88,270,90)
$shape.AddArc(160,160,88,88,0,90)
$shape.AddArc(8,160,88,88,90,90)
$shape.CloseFigure()
$brush = New-Object Drawing.Drawing2D.LinearGradientBrush ([Drawing.Point]::new(0,0)),([Drawing.Point]::new(256,256)),([Drawing.ColorTranslator]::FromHtml('#B7EBD6')),([Drawing.ColorTranslator]::FromHtml('#68BFA0'))
$g.FillPath($brush,$shape)
$pen = New-Object Drawing.Pen ([Drawing.ColorTranslator]::FromHtml('#102E28')),14
$pen.StartCap = $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
$points = [Drawing.PointF[]]@([Drawing.PointF]::new(45,133),[Drawing.PointF]::new(83,133),[Drawing.PointF]::new(105,70),[Drawing.PointF]::new(139,187),[Drawing.PointF]::new(164,112),[Drawing.PointF]::new(182,133),[Drawing.PointF]::new(211,133))
$g.DrawLines($pen,$points)
$bitmap.Save((Join-Path $iconDir 'icon.png'),[Drawing.Imaging.ImageFormat]::Png)
$images = @()
foreach ($size in @(16,24,32,48,64,128,256)) {
  $small = New-Object Drawing.Bitmap $size,$size
  $sg = [Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bitmap,0,0,$size,$size)
  $stream = New-Object IO.MemoryStream
  $small.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
  $images += @{ Size=$size; Bytes=$stream.ToArray() }
  $stream.Dispose(); $sg.Dispose(); $small.Dispose()
}
$ico = [IO.File]::Create((Join-Path $iconDir 'icon.ico'))
$writer = New-Object IO.BinaryWriter $ico
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
  $offset = 6 + 16 * $images.Count
  foreach ($entry in $images) {
    $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$entry.Bytes.Length); $writer.Write([uint32]$offset)
    $offset += $entry.Bytes.Length
  }
  foreach ($entry in $images) { $writer.Write([byte[]]$entry.Bytes) }
} finally { $writer.Dispose(); $ico.Dispose(); $g.Dispose(); $pen.Dispose(); $brush.Dispose(); $shape.Dispose(); $bitmap.Dispose() }
