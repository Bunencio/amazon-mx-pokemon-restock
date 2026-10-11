<#
.SYNOPSIS
  Registra (o reemplaza) la tarea programada de Windows que corre el monitor cada N minutos.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -IntervalMinutes 15
#>
param(
  [string]$TaskName = 'BunugraphsPokemonRestock',
  [int]$IntervalMinutes = 10
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'run-monitor-hidden.vbs'
if (-not (Test-Path $vbs)) { throw "No se encontró $vbs" }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
$start = (Get-Date).AddMinutes(1)
$interval = New-TimeSpan -Minutes $IntervalMinutes
try {
  $trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval $interval
} catch {
  # Versiones viejas exigen una duración explícita; MaxValue = indefinido.
  $trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval $interval -RepetitionDuration ([TimeSpan]::MaxValue)
}
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 8) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RunOnlyIfNetworkAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Pokémon Restock Monitor (Amazon México) - una pasada cada $IntervalMinutes min desde $root" -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "Tarea '$TaskName' registrada. Estado: $($task.State). Primera ejecución: $start. Intervalo: $IntervalMinutes min."
Write-Host "Logs: $root\logs\monitor-YYYY-MM-DD.log"
Write-Host "Para correrla ahora: Start-ScheduledTask -TaskName $TaskName"
