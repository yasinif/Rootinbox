Add-Type -AssemblyName System.Drawing

$publicDir = "d:\web chat\web\public"
if (!(Test-Path $publicDir)) {
    New-Item -ItemType Directory -Path $publicDir -Force | Out-Null
}

function Generate-Icon {
    param(
        [int]$size,
        [string]$outputPath,
        [bool]$maskable = $false
    )

    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $g.Clear([System.Drawing.Color]::Transparent)

    # Colors
    $colorTop = [System.Drawing.Color]::FromArgb(255, 51, 144, 236)   # #3390ec
    $colorBottom = [System.Drawing.Color]::FromArgb(255, 29, 116, 198) # #1d74c6
    $gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF 0, 0),
        (New-Object System.Drawing.PointF $size, $size),
        $colorTop,
        $colorBottom
    )

    if ($maskable) {
        # Full bleed for Android adaptive icons
        $g.FillRectangle($gradBrush, 0, 0, $size, $size)
    } else {
        # Rounded rectangle
        $cornerRad = [float]($size * 0.22)
        $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $diameter = $cornerRad * 2
        $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
        $path.AddArc($size - $diameter, 0, $diameter, $diameter, 270, 90)
        $path.AddArc($size - $diameter, $size - $diameter, $diameter, $diameter, 0, 90)
        $path.AddArc(0, $size - $diameter, $diameter, $diameter, 90, 90)
        $path.CloseFigure()
        $g.FillPath($gradBrush, $path)
        $path.Dispose()
    }
    $gradBrush.Dispose()

    # Scale factor for emblem
    $scale = $size / 512.0
    $safeScale = if ($maskable) { 0.85 } else { 1.0 }

    # Draw speech bubble silhouette in translucent white
    $bubblePath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bx = (130 * $scale * $safeScale) + ($size * (1 - $safeScale) / 2)
    $by = (110 * $scale * $safeScale) + ($size * (1 - $safeScale) / 2)
    $bw = 252 * $scale * $safeScale
    $bh = 220 * $scale * $safeScale
    $br = 40 * $scale * $safeScale
    $bd = $br * 2

    $bubblePath.AddArc($bx, $by, $bd, $bd, 180, 90)
    $bubblePath.AddArc($bx + $bw - $bd, $by, $bd, $bd, 270, 90)
    $bubblePath.AddArc($bx + $bw - $bd, $by + $bh - $bd, $bd, $bd, 0, 90)
    # tail on bottom left
    $bubblePath.AddLine($bx + $bw - $bd, $by + $bh, $bx + ($bw * 0.4), $by + $bh)
    $bubblePath.AddLine($bx + ($bw * 0.4), $by + $bh, $bx + ($bw * 0.15), $by + $bh + (38 * $scale * $safeScale))
    $bubblePath.AddLine($bx + ($bw * 0.15), $by + $bh + (38 * $scale * $safeScale), $bx + ($bw * 0.22), $by + $bh)
    $bubblePath.AddArc($bx, $by + $bh - $bd, $bd, $bd, 90, 90)
    $bubblePath.CloseFigure()

    $bubbleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(40, 255, 255, 255))
    $g.FillPath($bubbleBrush, $bubblePath)
    $bubbleBrush.Dispose()
    $bubblePath.Dispose()

    # Draw bold "R" monogram in solid crisp white
    # Draw via stylized GraphicsPath for pixel-perfection
    $rPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cx = $size / 2.0
    $cy = $size / 2.0 - (10 * $scale * $safeScale)
    $rw = 135 * $scale * $safeScale
    $rh = 175 * $scale * $safeScale
    $rx = $cx - ($rw / 2)
    $ry = $cy - ($rh / 2)

    # Vertical bar
    $stemW = 34 * $scale * $safeScale
    $rPath.AddRectangle((New-Object System.Drawing.RectangleF $rx, $ry, $stemW, $rh))

    # Top loop outer
    $loopH = $rh * 0.58
    $loopW = $rw
    $loopPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $loopPath.AddArc($rx + $stemW - 5, $ry, ($loopW - $stemW + 5) * 2 - ($loopH), $loopH, 270, 180)
    $loopPath.AddLine($rx + $stemW - 5, $ry + $loopH, $rx + $stemW - 5, $ry)

    # Top loop inner cut
    $innerPad = 26 * $scale * $safeScale
    $innerH = $loopH - ($innerPad * 2)
    $innerW = $loopW - $stemW - $innerPad

    # Leg
    $legX1 = $rx + ($stemW * 0.7)
    $legY1 = $ry + $loopH - (10 * $scale * $safeScale)
    $legX2 = $rx + $rw + (4 * $scale * $safeScale)
    $legY2 = $ry + $rh
    $legPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $legPoints = @(
        (New-Object System.Drawing.PointF ($rx + $stemW - (2 * $scale)), ($ry + $loopH - (16 * $scale * $safeScale))),
        (New-Object System.Drawing.PointF ($rx + $stemW + ($innerW * 0.6)), ($ry + $loopH - (16 * $scale * $safeScale))),
        (New-Object System.Drawing.PointF $legX2, $legY2),
        (New-Object System.Drawing.PointF ($legX2 - ($stemW * 1.1)), $legY2),
        (New-Object System.Drawing.PointF ($rx + $stemW - (2 * $scale)), ($ry + $loopH + (12 * $scale * $safeScale)))
    )
    $legPath.AddPolygon($legPoints)

    $whiteBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $g.FillPath($whiteBrush, $rPath)
    $g.FillPath($whiteBrush, $loopPath)
    $g.FillPath($whiteBrush, $legPath)

    # Clear inner loop cutout
    $innerBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF 0, 0),
        (New-Object System.Drawing.PointF $size, $size),
        $colorTop,
        $colorBottom
    )
    $innerArc = New-Object System.Drawing.Drawing2D.GraphicsPath
    $innerArc.AddArc($rx + $stemW + (6 * $scale), $ry + $innerPad, ($innerW) * 2 - $innerH, $innerH, 270, 180)
    $innerArc.CloseFigure()
    $g.FillPath($innerBrush, $innerArc)

    # Green security dot (top-right of bubble)
    $greenBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 197, 94))
    $dotR = 14 * $scale * $safeScale
    $dotX = $bx + $bw - ($dotR * 1.5)
    $dotY = $by + ($dotR * 1.5)
    $g.FillEllipse($greenBrush, [float]($dotX - $dotR), [float]($dotY - $dotR), [float]($dotR * 2), [float]($dotR * 2))

    # Clean up
    $whiteBrush.Dispose()
    $innerBrush.Dispose()
    $greenBrush.Dispose()
    $rPath.Dispose()
    $loopPath.Dispose()
    $legPath.Dispose()
    $innerArc.Dispose()
    $g.Dispose()

    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "Generated: $outputPath"
}

# Generate all icons
Generate-Icon -size 192 -outputPath "$publicDir\icon-192x192.png" -maskable $false
Generate-Icon -size 512 -outputPath "$publicDir\icon-512x512.png" -maskable $false
Generate-Icon -size 192 -outputPath "$publicDir\icon-maskable-192x192.png" -maskable $true
Generate-Icon -size 512 -outputPath "$publicDir\icon-maskable-512x512.png" -maskable $true
Generate-Icon -size 180 -outputPath "$publicDir\apple-touch-icon.png" -maskable $false
Generate-Icon -size 48  -outputPath "$publicDir\favicon.png" -maskable $false
