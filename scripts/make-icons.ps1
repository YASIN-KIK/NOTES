# Generates the app icon and Microsoft Store (AppX) logo assets.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
$appxDir = Join-Path $buildDir 'appx'
New-Item -ItemType Directory -Force -Path $buildDir, $appxDir | Out-Null

function New-RoundedPath {
    param([float]$X, [float]$Y, [float]$W, [float]$H, [float]$R)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = [Math]::Min($R * 2, [Math]::Min($W, $H))
    $p.AddArc($X, $Y, $d, $d, 180, 90)
    $p.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $p.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $p.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Add-Mark {
    param($G)
    # The mark is drawn in a 512x512 coordinate space.
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 67, 97, 238))
    $line = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 201, 210, 234))

    # Page
    $page = New-RoundedPath 136 100 240 312 34
    $G.FillPath($white, $page)

    # Title bar
    $title = New-RoundedPath 176 148 160 26 13
    $G.FillPath($blue, $title)

    # Text lines
    foreach ($y in @(202, 240, 278)) {
        $w = if ($y -eq 278) { 108 } else { 160 }
        $bar = New-RoundedPath 176 $y $w 16 8
        $G.FillPath($line, $bar)
    }

    $white.Dispose(); $blue.Dispose(); $line.Dispose()
    $page.Dispose(); $title.Dispose()
}

function New-Icon {
    param(
        [int]$Width,
        [int]$Height,
        [string]$Path,
        [switch]$Rounded,
        [double]$MarkHeight = 0.62   # fraction of the canvas height used by the mark
    )

    $bmp = New-Object System.Drawing.Bitmap $Width, $Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Background gradient
    $rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height
    $c1 = [System.Drawing.Color]::FromArgb(255, 92, 118, 255)
    $c2 = [System.Drawing.Color]::FromArgb(255, 40, 54, 168)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 90.0

    if ($Rounded) {
        $radius = [Math]::Max(6, $Width * 0.22)
        $bg = New-RoundedPath 0 0 $Width $Height $radius
        $g.FillPath($brush, $bg)
        $bg.Dispose()
    } else {
        $g.FillRectangle($brush, $rect)
    }
    $brush.Dispose()

    # Mark, scaled and centered
    $markSize = [Math]::Min($Width, $Height) * $MarkHeight
    $scale = $markSize / 512.0
    $g.TranslateTransform((($Width - $markSize) / 2), (($Height - $markSize) / 2))
    $g.ScaleTransform($scale, $scale)
    Add-Mark $g

    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "created $Path ($Width x $Height)"
}

# Desktop / executable icon (electron-builder converts this to .ico)
New-Icon -Width 512 -Height 512 -Path (Join-Path $buildDir 'icon.png') -Rounded -MarkHeight 0.78

# Microsoft Store tile assets
New-Icon -Width 50  -Height 50  -Path (Join-Path $appxDir 'StoreLogo.png')        -MarkHeight 0.78
New-Icon -Width 44  -Height 44  -Path (Join-Path $appxDir 'Square44x44Logo.png')  -MarkHeight 0.80
New-Icon -Width 150 -Height 150 -Path (Join-Path $appxDir 'Square150x150Logo.png') -MarkHeight 0.66
New-Icon -Width 310 -Height 150 -Path (Join-Path $appxDir 'Wide310x150Logo.png')   -MarkHeight 0.70

Write-Host 'Icons generated.'
