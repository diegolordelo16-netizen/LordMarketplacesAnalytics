param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:RUNNER_TEMP 'marketplace-intelligence-smoke'
$dataDir = Join-Path $env:LOCALAPPDATA 'MarketplaceIntelligence'
$hostKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.marketplaceintelligence.host',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.marketplaceintelligence.host'
)
$uninstaller = Join-Path $installDir 'unins000.exe'
$log = Join-Path $env:RUNNER_TEMP 'marketplace-installer-smoke.log'
try {
  $setup = Start-Process -FilePath $Installer -ArgumentList @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', "/DIR=`"$installDir`"", "/LOG=`"$log`""
  ) -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "Falha ao instalar (código $($setup.ExitCode))." }
  $extensionId = (Get-Content -LiteralPath (Join-Path $dataDir 'extension-id.txt') -Raw).Trim()
  if ($extensionId -cnotmatch '^[a-p]{32}$') { throw 'ID da extensão inválido.' }
  foreach ($key in $hostKeys) {
    $manifestPath = (Get-Item -LiteralPath $key).GetValue('')
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.allowed_origins -notcontains "chrome-extension://$extensionId/" -or
        -not (Test-Path -LiteralPath $manifest.path -PathType Leaf)) {
      throw "Registro do host nativo inválido: $key"
    }
  }
  $health = $null
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:47811/api/health' -TimeoutSec 2
      if ($health.ok) { break }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $health.ok) { throw 'O serviço instalado não respondeu no endpoint de saúde.' }
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Desinstalador ausente.' }
} finally {
  Get-Process -Name node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq (Join-Path $installDir 'node.exe') } |
    Stop-Process -Force
  if (Test-Path -LiteralPath $uninstaller) {
    $removed = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -Wait -PassThru
    if ($removed.ExitCode -ne 0) { throw "Falha ao desinstalar (código $($removed.ExitCode))." }
  }
}
foreach ($key in $hostKeys) {
  if (Test-Path -LiteralPath $key) { throw "Registro do host permaneceu após desinstalar: $key" }
}
Write-Output 'Instalação, serviço local, registro Chrome/Edge e desinstalação validados.'
