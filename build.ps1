<#
.SYNOPSIS
  Builds Code Compare for Windows, or drops a desktop shortcut that runs it from source.

.EXAMPLE
  .\build.ps1                    # portable single .exe in dist\
  .\build.ps1 -Task Installer    # NSIS setup .exe in dist\
  .\build.ps1 -Task Dir          # unpacked folder in dist\win-unpacked\ (fastest, for testing)
  .\build.ps1 -Task Shortcut     # desktop .lnk that launches the repo copy, no packaging
  .\build.ps1 -Task Clean        # delete dist\
#>
[CmdletBinding()]
param(
  [ValidateSet('Portable', 'Installer', 'Dir', 'Shortcut', 'Clean')]
  [string]$Task = 'Portable'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root    = $PSScriptRoot
$DistDir = Join-Path $Root 'dist'
$IconPng = Join-Path $Root 'assets\icon.png'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# Windows accepts an .ico whose single image is a raw PNG (Vista+). Saves pulling in
# an image library just to get a shortcut icon.
function New-IcoFromPng([string]$PngPath, [string]$IcoPath) {
  $png = [System.IO.File]::ReadAllBytes($PngPath)
  $ms  = New-Object System.IO.MemoryStream
  $bw  = New-Object System.IO.BinaryWriter($ms)
  try {
    $bw.Write([UInt16]0)              # reserved
    $bw.Write([UInt16]1)              # type: icon
    $bw.Write([UInt16]1)              # image count
    $bw.Write([Byte]0)                # width  0 means 256
    $bw.Write([Byte]0)                # height 0 means 256
    $bw.Write([Byte]0)                # palette entries
    $bw.Write([Byte]0)                # reserved
    $bw.Write([UInt16]1)              # color planes
    $bw.Write([UInt16]32)             # bits per pixel
    $bw.Write([UInt32]$png.Length)    # image size
    $bw.Write([UInt32]22)             # offset to image data
    $bw.Write($png)
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($IcoPath, $ms.ToArray())
  }
  finally { $bw.Dispose(); $ms.Dispose() }
}

if ($Task -eq 'Clean') {
  if (Test-Path $DistDir) {
    Write-Step "Removing $DistDir"
    Remove-Item $DistDir -Recurse -Force
  }
  else { Write-Host 'Nothing to clean.' }
  return
}

if (-not (Test-Path (Join-Path $Root 'node_modules\electron\dist\electron.exe'))) {
  Write-Step 'Installing dependencies (npm install)'
  Push-Location $Root
  try { npm install; if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' } }
  finally { Pop-Location }
}

if ($Task -eq 'Shortcut') {
  New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
  $ico = Join-Path $DistDir 'code-compare.ico'
  Write-Step "Generating $ico"
  New-IcoFromPng -PngPath $IconPng -IcoPath $ico

  $lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Code Compare.lnk'
  Write-Step "Creating $lnkPath"
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath       = Join-Path $Root 'node_modules\electron\dist\electron.exe'
  $lnk.Arguments        = '"{0}"' -f $Root
  $lnk.WorkingDirectory = $Root
  $lnk.IconLocation     = "$ico,0"
  $lnk.Description      = 'Code Compare (runs from source)'
  $lnk.Save()

  Write-Host ''
  Write-Host "Shortcut created: $lnkPath" -ForegroundColor Green
  Write-Host "It runs the working copy at $Root - moving or deleting the repo (or node_modules) breaks it."
  return
}

# --- packaged builds -------------------------------------------------------

$builderCli = Join-Path $Root 'node_modules\.bin\electron-builder.cmd'
if (-not (Test-Path $builderCli)) {
  Write-Step 'Installing electron-builder (devDependency)'
  Push-Location $Root
  try {
    npm install --save-dev electron-builder
    if ($LASTEXITCODE -ne 0) { throw 'npm install electron-builder failed.' }
  }
  finally { Pop-Location }
}

$configPath = Join-Path ([System.IO.Path]::GetTempPath()) 'code-compare.electron-builder.yml'
@'
appId: dev.mynrd.code-compare
productName: Code Compare
directories:
  output: dist
  buildResources: assets
files:
  - main.js
  - preload.js
  - package.json
  - lib/**/*
  - renderer/**/*
  - assets/**/*
win:
  icon: assets/icon.png
portable:
  artifactName: CodeCompare-${version}-portable.exe
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Code Compare
  artifactName: CodeCompare-Setup-${version}.exe
'@ | Set-Content -Path $configPath -Encoding UTF8

$builderArgs = switch ($Task) {
  'Portable'  { @('--win', 'portable') }
  'Installer' { @('--win', 'nsis') }
  'Dir'       { @('--win', '--dir') }
}

Write-Step "electron-builder $($builderArgs -join ' ')"
Push-Location $Root
try {
  & $builderCli @builderArgs --config $configPath
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE." }
}
finally { Pop-Location }

Write-Host ''
Write-Host 'Build output:' -ForegroundColor Green
Get-ChildItem $DistDir -Force |
  Where-Object { $_.Extension -in '.exe', '' } |
  Select-Object Name, @{ n = 'Size'; e = { if ($_.PSIsContainer) { '<dir>' } else { '{0:N1} MB' -f ($_.Length / 1MB) } } } |
  Format-Table -AutoSize
