<#
.SYNOPSIS
  First-run setup for the GoHighLevel + Claude Code connector (Windows / PowerShell).
.DESCRIPTION
  Creates .env from .env.example if missing, then checks that GHL_PIT_TOKEN,
  GHL_LOCATION_ID, GHL_API_BASE_URL and GHL_API_VERSION are set. Prints exactly
  what to do next.
.EXAMPLE
  .\setup.ps1
#>
$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$EnvFile  = Join-Path $RepoRoot '.env'
$Example  = Join-Path $RepoRoot '.env.example'

Write-Host ''
Write-Host '=== GoHighLevel + Claude Code setup ===' -ForegroundColor Cyan

if (-not (Test-Path $EnvFile)) {
  if (-not (Test-Path $Example)) { Write-Host 'ERROR: .env.example is missing.' -ForegroundColor Red; exit 1 }
  Copy-Item $Example $EnvFile
  Write-Host 'Created .env from .env.example.' -ForegroundColor Green
} else {
  Write-Host '.env already exists — leaving it as is.'
}

# parse .env
$vals = @{}
Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $k, $v = $line.Split('=', 2)
    $vals[$k.Trim()] = $v.Trim().Trim('"')
  }
}

$missing = @()
foreach ($key in @('GHL_PIT_TOKEN', 'GHL_LOCATION_ID', 'GHL_API_BASE_URL', 'GHL_API_VERSION')) {
  if (-not $vals.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($vals[$key])) { $missing += $key }
}

Write-Host ''
if ($missing.Count -eq 0) {
  Write-Host 'All values are set. You are ready.' -ForegroundColor Green
  if (-not $vals['GHL_PIT_TOKEN'].StartsWith('pit-')) {
    Write-Host ''
    Write-Host "NOTE: GHL_PIT_TOKEN does not start with 'pit-'. Private Integration Tokens do." -ForegroundColor Yellow
    Write-Host '      If you pasted an old v1 API key, API v2 calls will fail with 401.' -ForegroundColor Yellow
  }
  Write-Host 'Test the API:  .\.claude\skills\ghl\scripts\ghl.ps1 whoami'
  Write-Host 'Launch Claude: .\claude-here.ps1'
} else {
  Write-Host ('Still need to fill in: ' + ($missing -join ', ')) -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Open .env and set:' -ForegroundColor Yellow
  if ($missing -contains 'GHL_PIT_TOKEN') {
    Write-Host '  GHL_PIT_TOKEN     HighLevel -> Settings -> Other Settings -> Private Integrations'
    Write-Host '                    -> Create new Integration -> tick scopes -> copy the pit-... token'
    Write-Host '                    (shown ONCE - if you lose it, create a new integration)'
  }
  if ($missing -contains 'GHL_LOCATION_ID')  { Write-Host '  GHL_LOCATION_ID   HighLevel -> Settings -> Business Profile -> Location ID' }
  if ($missing -contains 'GHL_API_BASE_URL') { Write-Host '  GHL_API_BASE_URL  https://services.leadconnectorhq.com  (leave as-is)' }
  if ($missing -contains 'GHL_API_VERSION')  { Write-Host '  GHL_API_VERSION   2021-07-28  (leave as-is)' }
  Write-Host ''
  Write-Host 'The same token also authenticates the LeadConnector MCP - there is no second token.'
  Write-Host ''
  Write-Host 'Then run  .\setup.ps1  again to confirm.'
}
Write-Host ''
