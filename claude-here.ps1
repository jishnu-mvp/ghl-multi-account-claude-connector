<#
.SYNOPSIS
  Load .env into the environment, then launch Claude Code in this folder (Windows).
.DESCRIPTION
  .mcp.json references ${GHL_PIT_TOKEN} and ${GHL_LOCATION_ID}. Those variables must exist
  in the environment Claude Code runs in, or the leadconnector MCP server will not connect.
  This wrapper loads .env and then starts `claude`, so the token is always available.
.EXAMPLE
  .\claude-here.ps1
#>
$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$EnvFile  = Join-Path $RepoRoot '.env'

if (-not (Test-Path $EnvFile)) {
  Write-Host 'No .env found. Run  .\setup.ps1  first.' -ForegroundColor Yellow
  exit 1
}

Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $k, $v = $line.Split('=', 2)
    Set-Item -Path "Env:$($k.Trim())" -Value ($v.Trim().Trim('"'))
  }
}

if ([string]::IsNullOrWhiteSpace($env:GHL_PIT_TOKEN)) {
  Write-Host 'WARNING: GHL_PIT_TOKEN is empty - the LeadConnector MCP will not connect, and the' -ForegroundColor Yellow
  Write-Host '         /ghl API helper scripts will fail too. Set it in .env (Settings -> Other' -ForegroundColor Yellow
  Write-Host '         Settings -> Private Integrations).' -ForegroundColor Yellow
} elseif ([string]::IsNullOrWhiteSpace($env:GHL_LOCATION_ID)) {
  Write-Host 'WARNING: GHL_LOCATION_ID is empty - sub-account-scoped calls will fail.' -ForegroundColor Yellow
  Write-Host '         Set it in .env (Settings -> Business Profile -> Location ID).' -ForegroundColor Yellow
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host 'Claude Code CLI (`claude`) not found on PATH. Install it, then rerun.' -ForegroundColor Red
  exit 1
}

Write-Host 'Launching Claude Code with GoHighLevel env loaded...' -ForegroundColor Green
claude @args
