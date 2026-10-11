<#
.SYNOPSIS
  Elimina la tarea programada del monitor.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall-task.ps1
#>
param([string]$TaskName = 'BunugraphsPokemonRestock')

$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Tarea '$TaskName' eliminada."
} else {
  Write-Host "La tarea '$TaskName' no existe."
}
