# Captura la conversacion USB entre odin4 (d.exe) y el telefono durante un flasheo completo.
# Uso (como administrador):  captura_odin.ps1 -Carpeta "D:\SAMSUNG\SAMFW.COM_..._fac" [-HomeCsc] [-Puerto COM8]
param(
    [Parameter(Mandatory = $true)][string]$Carpeta,
    [switch]$HomeCsc,
    [string]$Puerto = "",
    [int]$SnapLen = 4096   # guarda completos los paquetes de control; recorta los bloques de datos grandes
)

$ErrorActionPreference = "Stop"
$odin = "C:\SamFwTool\data\d.exe"
$usbpcap = "C:\Program Files\USBPcap\USBPcapCMD.exe"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Ejecuta este script como administrador (USBPcap lo necesita)." }
if (Get-Process SamFwTool -ErrorAction SilentlyContinue) { throw "Cierra SamFwTool primero (ocupa el puerto)." }

function Find-Fw([string]$prefix) {
    foreach ($ext in "*.tar.md5", "*.tar") {
        $f = Get-ChildItem -LiteralPath $Carpeta -Filter "${prefix}_$ext" |
             Where-Object { $prefix -ne "CSC" -or $_.Name -notlike "HOME_CSC*" } |
             Sort-Object Name | Select-Object -First 1
        if ($f) { return $f.FullName }
    }
    throw "No encontre $prefix en $Carpeta"
}
$bl = Find-Fw "BL"; $ap = Find-Fw "AP"; $cp = Find-Fw "CP"
$csc = if ($HomeCsc) { Find-Fw "HOME_CSC" } else { Find-Fw "CSC" }

if (-not $Puerto) {
    $Puerto = (& $odin -l | Select-String -Pattern "COM\d+" | Select-Object -First 1).Matches.Value
    if (-not $Puerto) { throw "No hay equipo en download mode (d.exe -l no devolvio nada)." }
}

$out = Join-Path $PSScriptRoot (Get-Date -Format "yyyyMMdd_HHmmss")
New-Item -ItemType Directory -Path $out | Out-Null
Write-Host "Salida: $out" -ForegroundColor Cyan
Write-Host "Puerto: $Puerto" -ForegroundColor Cyan

# 1) Empezar a grabar en todos los root hubs (despues se queda solo el que tiene el Samsung)
$caps = @()
foreach ($i in 1..8) {
    $file = Join-Path $out "usb_hub$i.pcap"
    $p = Start-Process -FilePath $usbpcap -PassThru -WindowStyle Hidden -ArgumentList @(
        "-d", "\\.\USBPcap$i", "-o", "`"$file`"", "-s", "$SnapLen", "-b", "16777216", "-A", "--inject-descriptors")
    $caps += [pscustomobject]@{ Proc = $p; File = $file }
}
Start-Sleep -Seconds 3
$caps = @($caps | Where-Object { -not $_.Proc.HasExited })
Write-Host "Grabando en $($caps.Count) hub(s)" -ForegroundColor Cyan
if ($caps.Count -eq 0) { throw "USBPcap no pudo grabar. Reinicia la PC si acabas de instalarlo." }

# 2) Flashear con odin4 en modo verbose (mismo comando que SamFwTool + --verbose)
$odinArgs = @("--verbose", "--ignore-md5", "-b", $bl, "-a", $ap, "-c", $cp, "-s", $csc, "-d", $Puerto)
$verbose = Join-Path $out "odin_verbose.txt"
"CMD: `"$odin`" $($odinArgs -join ' ')" | Out-File $verbose -Encoding utf8
$t0 = Get-Date
$code = -1
try {
    $ErrorActionPreference = "Continue"
    & $odin @odinArgs 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $verbose -Append
    $code = $LASTEXITCODE
}
finally {
    # 3) Parar la grabacion siempre, aunque el flasheo falle
    Start-Sleep -Seconds 3
    $caps | ForEach-Object { if (-not $_.Proc.HasExited) { Stop-Process -Id $_.Proc.Id -Force } }
}
$secs = [int]((Get-Date) - $t0).TotalSeconds
"EXIT: $code  TIEMPO: $secs s" | Tee-Object -FilePath $verbose -Append

Get-ChildItem $out | Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table
Write-Host "Listo. Avisale a Claude la carpeta: $out" -ForegroundColor Green
