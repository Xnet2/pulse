# Long-lived helper: one JSON command per stdin line, one JSON reply per stdout line.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
$AppPath = 'Android\data\il.offlineplayer.music\files'
Add-Type -AssemblyName PresentationCore, WindowsBase

function Get-Child($folder, $name) {
  foreach ($i in $folder.Items()) { if ($i.Name -eq $name) { return $i } }
  return $null
}

function Get-PathFolder($folder, $path) {
  foreach ($part in $path.Split('\')) {
    $child = Get-Child $folder $part
    if (-not $child) { return $null }
    $folder = $child.GetFolder
  }
  return $folder
}

function Get-Devices {
  $shell = New-Object -ComObject Shell.Application
  return @($shell.Namespace(17).Items() | Where-Object { -not $_.IsFileSystem -and $_.Path -like '::*' })
}

function Find-Storage($deviceName, $storageName) {
  foreach ($d in Get-Devices) {
    if ($d.Name -ne $deviceName) { continue }
    return Get-Child $d.GetFolder $storageName
  }
  return $null
}

function Wait-File($folder, $name, $size, $seconds) {
  $base = [IO.Path]::GetFileNameWithoutExtension($name)
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    foreach ($i in $folder.Items()) {
      if (($i.Name -eq $name -or $i.Name -eq $base) -and [double]$i.ExtendedProperty('System.Size') -ge $size) { return $true }
    }
  }
  return $false
}

function Do-Scan($req) {
  $out = @()
  foreach ($d in Get-Devices) {
    $storages = @()
    foreach ($s in @($d.GetFolder.Items())) {
      if (-not $s.IsFolder) { continue }
      $capacity = 0
      if ($s.Path -match 'SID-\{[^,]*,,(\d+)\}') { $capacity = [double]$Matches[1] }
      $app = Get-PathFolder $s.GetFolder $AppPath
      $inbox = @()
      if ($app) { $inbox = @($app.Items() | ForEach-Object { [string]$_.Name } | Where-Object { $_ -like 'req-*' -or $_ -like 'cov-*' -or $_ -like 'cfg-*' -or $_ -like 'hello-*' }) }
      $music = $null
      if ($req.music) {
        $music = @()
        $m = Get-Child $s.GetFolder 'Music'
        if ($m) { $music = @($m.GetFolder.Items() | Where-Object { -not $_.IsFolder -and -not $_.Name.StartsWith('.') } | ForEach-Object { [string]$_.Name }) }
      }
      $storages += @{ name = $s.Name; capacity = $capacity; free = [double]$s.ExtendedProperty('System.FreeSpace'); hasApp = [bool]$app; inbox = $inbox; music = $music }
    }
    $out += @{ name = $d.Name; storages = $storages }
  }
  return @{ devices = $out }
}

function Do-Put($req) {
  $s = Find-Storage $req.device $req.storage
  if (-not $s) { return @{ ok = $false; error = 'storage' } }
  $folder = Get-PathFolder $s.GetFolder $AppPath
  if (-not $folder) { return @{ ok = $false; error = 'app' } }
  $name = Split-Path -Leaf $req.file
  $folder.CopyHere([string]$req.file, 1044)
  return @{ ok = (Wait-File $folder $name (Get-Item -LiteralPath $req.file).Length ([int]$req.wait)) }
}

function Do-Song($req) {
  $s = Find-Storage $req.device $req.storage
  if (-not $s) { return @{ ok = $false; error = 'storage' } }
  $music = Get-Child $s.GetFolder 'Music'
  if (-not $music) {
    $s.GetFolder.NewFolder('Music')
    Start-Sleep -Milliseconds 800
    $music = Get-Child $s.GetFolder 'Music'
  }
  if (-not $music) { return @{ ok = $false; error = 'music' } }
  $name = Split-Path -Leaf $req.file
  $base = [IO.Path]::GetFileNameWithoutExtension($name)
  foreach ($i in $music.GetFolder.Items()) { if ($i.Name -eq $name -or $i.Name -eq $base) { return @{ ok = $true; existed = $true } } }
  $music.GetFolder.CopyHere([string]$req.file, 1044)
  return @{ ok = (Wait-File $music.GetFolder $name (Get-Item -LiteralPath $req.file).Length 240) }
}

function Convert-Image($src, $dst, $size) {
  $stream = [IO.File]::OpenRead($src)
  try {
    $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create($stream, [Windows.Media.Imaging.BitmapCreateOptions]::None, [Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
    $frame = $decoder.Frames[0]
    $side = [Math]::Min($frame.PixelWidth, $frame.PixelHeight)
    $rect = New-Object Windows.Int32Rect([int](($frame.PixelWidth - $side) / 2), [int](($frame.PixelHeight - $side) / 2), $side, $side)
    $crop = New-Object Windows.Media.Imaging.CroppedBitmap($frame, $rect)
    $scale = [Math]::Min(1.0, $size / $side)
    $scaled = New-Object Windows.Media.Imaging.TransformedBitmap($crop, (New-Object Windows.Media.ScaleTransform($scale, $scale)))
    $encoder = New-Object Windows.Media.Imaging.JpegBitmapEncoder
    $encoder.QualityLevel = 86
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($scaled))
    $out = [IO.File]::Create($dst)
    try { $encoder.Save($out) } finally { $out.Close() }
  } finally { $stream.Close() }
}

function Do-Images($req) {
  $done = 0
  foreach ($f in Get-ChildItem -LiteralPath $req.dir -File) {
    try { Convert-Image $f.FullName (Join-Path $req.out ($f.BaseName + '.jpg')) ([int]$req.size); $done++ } catch {}
  }
  return @{ ok = $true; done = $done }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $req = $line | ConvertFrom-Json
  try {
    switch ($req.action) {
      'scan' { $reply = Do-Scan $req }
      'put' { $reply = Do-Put $req }
      'song' { $reply = Do-Song $req }
      'images' { $reply = Do-Images $req }
      default { $reply = @{ error = 'unknown' } }
    }
  } catch { $reply = @{ error = $_.Exception.Message } }
  $reply.id = $req.id
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 7 $reply))
  [Console]::Out.Flush()
}
