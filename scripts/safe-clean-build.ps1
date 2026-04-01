[CmdletBinding()]
param(
  [switch]$ForceStopNode
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

function Remove-NextBuildArtifacts {
  if (-not (Test-Path ".next")) {
    return
  }

  Remove-Item ".next" -Recurse -Force -ErrorAction Stop
}

function Get-NodeProcesses {
  @(Get-Process node -ErrorAction SilentlyContinue)
}

function Confirm-StopNodeProcesses {
  param(
    [int]$Count
  )

  while ($true) {
    $answer = Read-Host "A file in .next is locked. Stop all $Count local node processes and retry? [y/N]"
    $normalized = $answer.Trim().ToLowerInvariant()

    if ($normalized -eq "" -or $normalized -eq "n" -or $normalized -eq "no") {
      return $false
    }

    if ($normalized -eq "y" -or $normalized -eq "yes") {
      return $true
    }

    Write-Host "Please answer y or n."
  }
}

Write-Host "Repo root: $repoRoot"
Write-Host "Step 1/2: removing .next build artifacts if present..."

try {
  Remove-NextBuildArtifacts
} catch {
  $nodeProcesses = Get-NodeProcesses

  if (-not $nodeProcesses -or $nodeProcesses.Count -eq 0) {
    throw "Failed to remove .next and no local node processes were found. Close anything using this repo and retry."
  }

  Write-Host "Detected local node processes:"
  $nodeProcesses | Format-Table Id, ProcessName -AutoSize

  $shouldStop = $ForceStopNode.IsPresent
  if (-not $shouldStop) {
    $shouldStop = Confirm-StopNodeProcesses -Count $nodeProcesses.Count
  }

  if (-not $shouldStop) {
    throw "Build cache is still locked. Stop the relevant node or next dev process and rerun, or rerun this script with -ForceStopNode."
  }

  Write-Host "Step 1/2 retry: stopping local node processes and retrying .next cleanup..."
  $nodeProcesses | Stop-Process -Force -ErrorAction Stop
  Start-Sleep -Seconds 2
  Remove-NextBuildArtifacts
}

Write-Host "Step 2/2: running clean build..."
& corepack pnpm build
exit $LASTEXITCODE
