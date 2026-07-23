Add-Type -AssemblyName System.Drawing

$size = 128
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

# --- Rounded square background with diagonal gradient ---
function New-RoundedRect([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, $r * 2, $r * 2, 180, 90)
    $p.AddArc($x + $w - $r * 2, $y, $r * 2, $r * 2, 270, 90)
    $p.AddArc($x + $w - $r * 2, $y + $h - $r * 2, $r * 2, $r * 2, 0, 90)
    $p.AddArc($x, $y + $h - $r * 2, $r * 2, $r * 2, 90, 90)
    $p.CloseAllFigures()
    return $p
}

$bgPath = New-RoundedRect 4 4 120 120 26
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(4, 4)),
    (New-Object System.Drawing.Point(124, 124)),
    [System.Drawing.Color]::FromArgb(255, 79, 142, 247),
    [System.Drawing.Color]::FromArgb(255, 124, 92, 252)
)
$g.FillPath($bgBrush, $bgPath)

# --- Curly braces (drawn as stroked bezier paths, matching the SVG) ---
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 6.5)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

# Left brace {
$left = New-Object System.Drawing.Drawing2D.GraphicsPath
$left.StartFigure()
$left.AddBezier(42, 32, 35, 32, 31, 36, 31, 43)
$left.AddLine(31, 43, 31, 54)
$left.AddBezier(31, 54, 31, 58, 29, 60, 25, 60)
$left.AddLine(25, 60, 23, 60)
$left.AddLine(23, 60, 23, 68)
$left.AddLine(23, 68, 25, 68)
$left.AddBezier(25, 68, 29, 68, 31, 70, 31, 74)
$left.AddLine(31, 74, 31, 85)
$left.AddBezier(31, 85, 31, 92, 35, 96, 42, 96)
$g.DrawPath($pen, $left)

# Right brace }
$right = New-Object System.Drawing.Drawing2D.GraphicsPath
$right.StartFigure()
$right.AddBezier(86, 32, 93, 32, 97, 36, 97, 43)
$right.AddLine(97, 43, 97, 54)
$right.AddBezier(97, 54, 97, 58, 99, 60, 103, 60)
$right.AddLine(103, 60, 105, 60)
$right.AddLine(105, 60, 105, 68)
$right.AddLine(105, 68, 103, 68)
$right.AddBezier(103, 68, 99, 68, 97, 70, 97, 74)
$right.AddLine(97, 74, 97, 85)
$right.AddBezier(97, 85, 97, 92, 93, 96, 86, 96)
$g.DrawPath($pen, $right)

# --- Proto field bars (rounded pills) ---
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$bar1 = New-RoundedRect 48 44 22 6 3
$g.FillPath($white, $bar1)
$bar2 = New-RoundedRect 48 61 15 6 3
$g.FillPath(([System.Drawing.SolidBrush]([System.Drawing.Color]::FromArgb(217, 255, 255, 255))), $bar2)
$bar3 = New-RoundedRect 48 78 26 6 3
$g.FillPath(([System.Drawing.SolidBrush]([System.Drawing.Color]::FromArgb(179, 255, 255, 255))), $bar3)

# --- Field number dots (teal) ---
$teal = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 56, 225, 198))
$g.FillEllipse($teal, 76, 43, 8, 8)
$g.FillEllipse($teal, 76, 60, 8, 8)
$g.FillEllipse($teal, 76, 77, 8, 8)

# --- Save as PNG ---
$out = "d:\projects\proto_utils\media\icon.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Host "Saved: $out"
