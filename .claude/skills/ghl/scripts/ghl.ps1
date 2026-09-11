<#
GHL Multi-Account Claude Connector
Copyright (c) 2026 Jishnu Venugopal. All Rights Reserved.

Proprietary software. You may use this software as-is for your own
GoHighLevel account(s). You may NOT copy, redistribute, or use this
code (or any part of it) to build a new or competing product without
the owner's prior written permission. See LICENSE and NOTICE at the
repository root for full terms. This notice must not be removed.
Contact: jishhnnuu@gmail.com
#>

<#
.SYNOPSIS
  GoHighLevel (HighLevel / LeadConnector) API v2 helper for Claude Code (Windows / PowerShell).
.DESCRIPTION
  Reads GHL_PIT_TOKEN, GHL_LOCATION_ID, GHL_API_BASE_URL and GHL_API_VERSION from the
  repo-root .env and wraps the common HighLevel API v2 operations. Mirrors ghl.sh
  command-for-command — keep the two in sync.
.EXAMPLE
  .\ghl.ps1 whoami
.EXAMPLE
  .\ghl.ps1 list-contacts
.EXAMPLE
  .\ghl.ps1 raw GET /contacts/?locationId=XXX
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command,
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest,
  [Parameter()][string]$Account
)
$ErrorActionPreference = 'Stop'

# --- locate repo root (walk up until .env / .env.example) ---
function Find-RepoRoot {
  $dir = $PSScriptRoot
  for ($i = 0; $i -lt 8; $i++) {
    if ((Test-Path (Join-Path $dir '.env')) -or (Test-Path (Join-Path $dir '.env.example'))) { return $dir }
    $parent = Split-Path $dir -Parent
    if (-not $parent -or $parent -eq $dir) { break }
    $dir = $parent
  }
  return $PSScriptRoot
}

$RepoRoot = Find-RepoRoot
$EnvFile = Join-Path $RepoRoot '.env'
# No .env is fine as long as the token is already a real environment variable (e.g. set via
# a cloud environment's "Environment variables" panel instead of a file) — Need-Token/Need-Loc
# below catch the case where it's genuinely missing either way.

$vals = @{}
if (Test-Path $EnvFile) {
Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $k, $v = $line.Split('=', 2)
    $vals[$k.Trim()] = $v.Trim().Trim('"')
  }
}
}
function Val([string]$k, [string]$default = '') {
  # live environment wins over .env
  $fromEnv = [Environment]::GetEnvironmentVariable($k)
  if ($fromEnv -and $fromEnv.Trim()) { return $fromEnv.Trim() }
  if ($vals.ContainsKey($k) -and $vals[$k]) { return $vals[$k] }
  return $default
}

$AccountsFile = Join-Path $RepoRoot 'accounts.conf'
function Get-AccountRow {
  param([string]$Match, [int]$Column)  # Column: 1 = match by alias, 3 = match by token env var name
  if (-not (Test-Path $AccountsFile)) { return $null }
  foreach ($line in (Get-Content $AccountsFile)) {
    if ($line.StartsWith('#') -or -not $line.Trim()) { continue }
    $parts = $line.Split('|')
    if ($parts.Count -lt 4) { continue }
    if ($Column -eq 1 -and $parts[0] -ieq $Match) { return $parts }
    if ($Column -eq 3 -and $parts[2] -eq $Match) { return $parts }
  }
  return $null
}

# Resolve which token/location env vars to use: -Account <alias> picks a row from
# accounts.conf; with no -Account, GHL_PIT_TOKEN / GHL_LOCATION_ID (the default row) are
# used, exactly as before this feature existed.
$TokenVarName = 'GHL_PIT_TOKEN'
$LocVarName   = 'GHL_LOCATION_ID'
$AccountDisplay = ''
if ($Account) {
  $row = Get-AccountRow -Match $Account -Column 1
  if (-not $row) {
    Write-Host "Unknown account alias '$Account'. Known accounts:" -ForegroundColor Red
    if (Test-Path $AccountsFile) {
      Get-Content $AccountsFile | Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object {
        $p = $_.Split('|'); if ($p.Count -ge 2) { Write-Host "  $($p[0]) - $($p[1])" }
      }
    }
    exit 1
  }
  $AccountDisplay = $row[1]
  $TokenVarName = $row[2]
  $LocVarName   = $row[3]
}

$Token   = Val $TokenVarName
$Loc     = Val $LocVarName
$Company = Val 'GHL_COMPANY_ID'
$Base    = (Val 'GHL_API_BASE_URL' 'https://services.leadconnectorhq.com').TrimEnd('/')
$Version = Val 'GHL_API_VERSION' '2021-07-28'

# Checked lazily (inside Invoke-Ghl), not at load time, so `ghl.ps1` with no args can
# still print the command list before the developer has configured anything.
function Need-Token {
  if (-not $Token) {
    Write-Error "$TokenVarName is not set - create a Private Integration at Settings -> Other Settings -> Private Integrations, put its token in that env var, then run .\setup.ps1 to check."
  }
}

function Need-Loc {
  if (-not $Loc) {
    Write-Error "$LocVarName is not set - this command needs a sub-account id (Settings -> Business Profile)."
  }
}

function Invoke-Ghl {
  param([string]$Method, [string]$Path, $Body = $null)
  Need-Token
  $url = if ($Path -match '^https?://') { $Path } elseif ($Path.StartsWith('/')) { "$Base$Path" } else { "$Base/$Path" }
  $headers = @{
    'Authorization' = "Bearer $Token"
    'Version'       = $Version
    'Accept'        = 'application/json'
  }
  try {
    if ($null -ne $Body -and $Body -ne '') {
      Invoke-RestMethod -Method $Method -Uri $url -Headers $headers -ContentType 'application/json' -Body $Body
    } else {
      Invoke-RestMethod -Method $Method -Uri $url -Headers $headers
    }
  } catch {
    # Surface HighLevel's JSON error body — it names the missing scope on 401/403.
    # $_.ErrorDetails.Message carries it on both PowerShell 5.1 and 7+.
    $status = ''
    try { $status = [int]$_.Exception.Response.StatusCode } catch { }
    $text = $_.ErrorDetails.Message
    Write-Host ("HTTP $status from $Method $Path").Trim() -ForegroundColor Red
    if ($text) { Write-Host $text -ForegroundColor Red } else { Write-Host $_.Exception.Message -ForegroundColor Red }
    if ($status -eq 401 -or $status -eq 403) {
      Write-Host 'A 401/403 usually means the Private Integration is missing the scope for this endpoint. Add it in Settings -> Other Settings -> Private Integrations (a new token is issued).' -ForegroundColor Yellow
    }
    exit 1
  }
}

function Show-Json($obj) { $obj | ConvertTo-Json -Depth 25 }

# body: file path or inline JSON.
# Check for JSON first - Test-Path throws on strings containing characters that are
# illegal in a Windows path (e.g. the quotes in {"a":1}).
function Body-Of([string]$s) {
  $t = $s.Trim()
  if ($t.StartsWith('{') -or $t.StartsWith('[')) { return $s }
  if (Test-Path -LiteralPath $t -ErrorAction SilentlyContinue) { return (Get-Content -LiteralPath $t -Raw) }
  return $s
}

# "a,b" or "a" "b" -> '{"tags":["a","b"]}'
# Hand-built so a single tag still serialises as an array on PowerShell 5.1.
function Tags-Body([string[]]$items) {
  $flat = @()
  foreach ($i in $items) {
    foreach ($t in ($i -split ',')) { if ($t.Trim()) { $flat += $t.Trim() } }
  }
  $quoted = $flat | ForEach-Object { '"' + ($_ -replace '\\', '\\' -replace '"', '\"') + '"' }
  return '{"tags":[' + ($quoted -join ',') + ']}'
}

function Need-Args([int]$n, [string]$usage) {
  if ($Rest.Count -lt $n) { Write-Error "Usage: $usage" }
}

function Show-Usage {
@'
ghl.ps1 [-Account <alias>] <command> [args]   - HighLevel API v2 helper. See SKILL.md.
                Omit -Account to use the default sub-account. See accounts.conf for
                the list of known aliases (or add a new one there).

  Connection      whoami | get-location | list-locations
  Contacts        list-contacts [query] | get-contact <id> | search-contacts <file|json>
                  create-contact <file|json> | update-contact <id> <file|json>
                  upsert-contact <file|json> | delete-contact <id> | export-contact <id> [file]
                  add-tags <id> <tags> | remove-tags <id> <tags>
                  contact-notes <id> | add-note <id> <text>
                  contact-tasks <id> | add-task <id> <file|json>
                  contact-appointments <id> | duplicate-check <email>
  Automation      list-workflows | add-to-workflow <contactId> <workflowId>
                  remove-from-workflow <contactId> <workflowId>
                  list-campaigns | add-to-campaign <contactId> <campaignId>
                  remove-from-campaign <contactId> <campaignId>
  Conversations   list-conversations [contactId] | get-conversation <id>
                  messages <conversationId> | get-message <messageId>
                  send-message <file|json> | create-conversation <file|json>
  Opportunities   list-pipelines | search-opportunities [pipelineId]
                  get-opportunity <id> | create-opportunity <file|json>
                  update-opportunity <id> <file|json> | set-opportunity-status <id> <status>
                  delete-opportunity <id>
  Calendars       list-calendars | get-calendar <id>
                  free-slots <calendarId> <startEpochMs> <endEpochMs>
                  list-events <startEpochMs> <endEpochMs> [calendarId]
                  get-appointment <id> | create-appointment <file|json>
                  update-appointment <id> <file|json> | delete-event <id>
  Forms/Surveys   list-forms | form-submissions [formId]
                  list-surveys | survey-submissions [surveyId]
  Location config custom-fields | custom-values | list-tags | list-users | list-custom-menus
  Commerce        list-products | product-prices <productId> | list-invoices
                  list-orders | list-transactions | list-subscriptions
  Content         list-funnels | list-links | list-businesses | list-media
                  list-email-templates | list-blog-sites | list-social-posts
  Escape hatch    raw <METHOD> <path> [file|json]     <- any endpoint, full control
'@ | Write-Host
}

switch ($Command) {

  # ---------- connection ----------
  { $_ -in @('', $null, 'help', '-h', '--help') } { Show-Usage; break }

  'whoami' {
    if ($AccountDisplay) {
      Write-Host "Account    : $Account ($AccountDisplay)"
    } else {
      $defrow = Get-AccountRow -Match $TokenVarName -Column 3
      if ($defrow) {
        Write-Host "Account    : $($defrow[0]) ($($defrow[1])) [default]"
      } else {
        Write-Host "Account    : <not registered in accounts.conf - using default GHL_PIT_TOKEN>"
      }
    }
    Write-Host "Base URL   : $Base"
    Write-Host "Version    : $Version"
    Write-Host ("Location   : " + $(if ($Loc) { $Loc } else { '<not set>' }))
    if ($Token) {
      Write-Host ("Token      : " + $Token.Substring(0, [Math]::Min(8, $Token.Length)) + "... (" + $Token.Length + " chars)")
      if (-not $Token.StartsWith('pit-')) {
        Write-Host "             does not start with 'pit-' - is this really a Private Integration Token?" -ForegroundColor Yellow
      }
    } else {
      Write-Host 'Token      : <not set>'
    }
    Write-Host ("Company    : " + $(if ($Company) { $Company } else { '<not set>' }))
    Write-Host ''
    Write-Host 'Probing GET /locations/$GHL_LOCATION_ID ...'
    Need-Loc
    Show-Json (Invoke-Ghl GET "/locations/$Loc"); break
  }
  'get-location'   { Need-Loc; Show-Json (Invoke-Ghl GET "/locations/$Loc"); break }
  'list-locations' {
    # Agency-scoped: needs an AGENCY-level PIT (or OAuth). Will 401/403 on a sub-account token.
    $p = '/locations/search'
    if ($Company) { $p += "?companyId=$Company" }
    Show-Json (Invoke-Ghl GET $p); break
  }

  # ---------- contacts ----------
  'list-contacts' {
    Need-Loc
    $p = "/contacts/?locationId=$Loc&limit=100"
    if ($Rest.Count -ge 1) { $p += "&query=$($Rest[0])" }
    Show-Json (Invoke-Ghl GET $p); break
  }
  'get-contact'    { Need-Args 1 'get-contact <id>'; Show-Json (Invoke-Ghl GET "/contacts/$($Rest[0])"); break }
  'export-contact' {
    Need-Args 1 'export-contact <id> [file]'
    $file = if ($Rest.Count -ge 2) { $Rest[1] } else { "contact-$($Rest[0]).json" }
    Show-Json (Invoke-Ghl GET "/contacts/$($Rest[0])") | Set-Content $file
    Write-Host "Saved contact $($Rest[0]) to $file"; break
  }
  'search-contacts' { Need-Args 1 'search-contacts <file.json|inline-json>  (body: {locationId,page,pageLimit,filters,sort})'
                      Show-Json (Invoke-Ghl POST '/contacts/search' (Body-Of $Rest[0])); break }
  'create-contact'  { Need-Args 1 'create-contact <file.json|inline-json>  (must include locationId)'
                      Show-Json (Invoke-Ghl POST '/contacts/' (Body-Of $Rest[0])); break }
  'upsert-contact'  { Need-Args 1 'upsert-contact <file.json|inline-json>'
                      Show-Json (Invoke-Ghl POST '/contacts/upsert' (Body-Of $Rest[0])); break }
  'update-contact'  { Need-Args 2 'update-contact <id> <file.json|inline-json>  (do NOT include locationId)'
                      Show-Json (Invoke-Ghl PUT "/contacts/$($Rest[0])" (Body-Of $Rest[1])); break }
  'delete-contact'  { Need-Args 1 'delete-contact <id>'
                      Show-Json (Invoke-Ghl DELETE "/contacts/$($Rest[0])"); break }
  'duplicate-check' { Need-Loc; Need-Args 1 'duplicate-check <email>'
                      Show-Json (Invoke-Ghl GET "/contacts/search/duplicate?locationId=$Loc&email=$($Rest[0])"); break }
  'add-tags'    { Need-Args 2 'add-tags <contactId> <tag1,tag2>'
                  Show-Json (Invoke-Ghl POST "/contacts/$($Rest[0])/tags" (Tags-Body $Rest[1..($Rest.Count - 1)])); break }
  'remove-tags' { Need-Args 2 'remove-tags <contactId> <tag1,tag2>'
                  Show-Json (Invoke-Ghl DELETE "/contacts/$($Rest[0])/tags" (Tags-Body $Rest[1..($Rest.Count - 1)])); break }
  'contact-notes' { Need-Args 1 'contact-notes <contactId>'
                    Show-Json (Invoke-Ghl GET "/contacts/$($Rest[0])/notes"); break }
  'add-note'      { Need-Args 2 'add-note <contactId> <text>'
                    $text = ($Rest[1..($Rest.Count - 1)] -join ' ')
                    Show-Json (Invoke-Ghl POST "/contacts/$($Rest[0])/notes" (@{ body = $text } | ConvertTo-Json -Compress)); break }
  'contact-tasks' { Need-Args 1 'contact-tasks <contactId>'
                    Show-Json (Invoke-Ghl GET "/contacts/$($Rest[0])/tasks"); break }
  'add-task'      { Need-Args 2 'add-task <contactId> <file.json|inline-json>  (body: {title,dueDate,completed,assignedTo})'
                    Show-Json (Invoke-Ghl POST "/contacts/$($Rest[0])/tasks" (Body-Of $Rest[1])); break }
  'contact-appointments' { Need-Args 1 'contact-appointments <contactId>'
                    Show-Json (Invoke-Ghl GET "/contacts/$($Rest[0])/appointments"); break }

  # ---------- automation ----------
  'list-workflows' { Need-Loc; Show-Json (Invoke-Ghl GET "/workflows/?locationId=$Loc"); break }
  'add-to-workflow' { Need-Args 2 'add-to-workflow <contactId> <workflowId>'
                      Show-Json (Invoke-Ghl POST "/contacts/$($Rest[0])/workflow/$($Rest[1])" '{}'); break }
  'remove-from-workflow' { Need-Args 2 'remove-from-workflow <contactId> <workflowId>'
                      Show-Json (Invoke-Ghl DELETE "/contacts/$($Rest[0])/workflow/$($Rest[1])"); break }
  'list-campaigns' { Need-Loc; Show-Json (Invoke-Ghl GET "/campaigns/?locationId=$Loc"); break }
  'add-to-campaign' { Need-Args 2 'add-to-campaign <contactId> <campaignId>'
                      Show-Json (Invoke-Ghl POST "/contacts/$($Rest[0])/campaigns/$($Rest[1])" '{}'); break }
  'remove-from-campaign' { Need-Args 2 'remove-from-campaign <contactId> <campaignId>'
                      Show-Json (Invoke-Ghl DELETE "/contacts/$($Rest[0])/campaigns/$($Rest[1])"); break }

  # ---------- conversations ----------
  'list-conversations' {
    Need-Loc
    $p = "/conversations/search?locationId=$Loc"
    if ($Rest.Count -ge 1) { $p += "&contactId=$($Rest[0])" }
    Show-Json (Invoke-Ghl GET $p); break
  }
  'get-conversation' { Need-Args 1 'get-conversation <id>'
                       Show-Json (Invoke-Ghl GET "/conversations/$($Rest[0])"); break }
  'create-conversation' { Need-Args 1 'create-conversation <file.json|inline-json>  (body: {locationId,contactId})'
                       Show-Json (Invoke-Ghl POST '/conversations/' (Body-Of $Rest[0])); break }
  'messages'    { Need-Args 1 'messages <conversationId>'
                  Show-Json (Invoke-Ghl GET "/conversations/$($Rest[0])/messages"); break }
  'get-message' { Need-Args 1 'get-message <messageId>'
                  Show-Json (Invoke-Ghl GET "/conversations/messages/$($Rest[0])"); break }
  'send-message' {
    # OUTBOUND SIDE EFFECT - CLAUDE.md requires explicit user confirmation first.
    Need-Args 1 "send-message <file.json|inline-json>  (body: {type:'SMS'|'Email',contactId,message,...})"
    Show-Json (Invoke-Ghl POST '/conversations/messages' (Body-Of $Rest[0])); break
  }

  # ---------- opportunities ----------
  'list-pipelines' { Need-Loc; Show-Json (Invoke-Ghl GET "/opportunities/pipelines?locationId=$Loc"); break }
  'search-opportunities' {
    Need-Loc
    $p = "/opportunities/search?location_id=$Loc&limit=100"
    if ($Rest.Count -ge 1) { $p += "&pipeline_id=$($Rest[0])" }
    Show-Json (Invoke-Ghl GET $p); break
  }
  'get-opportunity' { Need-Args 1 'get-opportunity <id>'
                      Show-Json (Invoke-Ghl GET "/opportunities/$($Rest[0])"); break }
  'create-opportunity' { Need-Args 1 'create-opportunity <file.json|inline-json>  (body: {locationId,pipelineId,pipelineStageId,name,status,contactId})'
                      Show-Json (Invoke-Ghl POST '/opportunities/' (Body-Of $Rest[0])); break }
  'update-opportunity' { Need-Args 2 'update-opportunity <id> <file.json|inline-json>'
                      Show-Json (Invoke-Ghl PUT "/opportunities/$($Rest[0])" (Body-Of $Rest[1])); break }
  'set-opportunity-status' { Need-Args 2 'set-opportunity-status <id> <open|won|lost|abandoned>'
                      Show-Json (Invoke-Ghl PUT "/opportunities/$($Rest[0])/status" (@{ status = $Rest[1] } | ConvertTo-Json -Compress)); break }
  'delete-opportunity' { Need-Args 1 'delete-opportunity <id>'
                      Show-Json (Invoke-Ghl DELETE "/opportunities/$($Rest[0])"); break }

  # ---------- calendars ----------
  'list-calendars' { Need-Loc; Show-Json (Invoke-Ghl GET "/calendars/?locationId=$Loc"); break }
  'get-calendar'   { Need-Args 1 'get-calendar <calendarId>'
                     Show-Json (Invoke-Ghl GET "/calendars/$($Rest[0])"); break }
  'free-slots'     { Need-Args 3 'free-slots <calendarId> <startEpochMs> <endEpochMs>'
                     Show-Json (Invoke-Ghl GET "/calendars/$($Rest[0])/free-slots?startDate=$($Rest[1])&endDate=$($Rest[2])"); break }
  'list-events'    {
    Need-Loc; Need-Args 2 'list-events <startEpochMs> <endEpochMs> [calendarId]'
    $p = "/calendars/events?locationId=$Loc&startTime=$($Rest[0])&endTime=$($Rest[1])"
    if ($Rest.Count -ge 3) { $p += "&calendarId=$($Rest[2])" }
    Show-Json (Invoke-Ghl GET $p); break
  }
  'get-appointment' { Need-Args 1 'get-appointment <eventId>'
                      Show-Json (Invoke-Ghl GET "/calendars/events/appointments/$($Rest[0])"); break }
  'create-appointment' { Need-Args 1 'create-appointment <file.json|inline-json>  (body: {calendarId,locationId,contactId,startTime,...})'
                      Show-Json (Invoke-Ghl POST '/calendars/events/appointments' (Body-Of $Rest[0])); break }
  'update-appointment' { Need-Args 2 'update-appointment <eventId> <file.json|inline-json>'
                      Show-Json (Invoke-Ghl PUT "/calendars/events/appointments/$($Rest[0])" (Body-Of $Rest[1])); break }
  'delete-event'    { Need-Args 1 'delete-event <eventId>'
                      Show-Json (Invoke-Ghl DELETE "/calendars/events/$($Rest[0])"); break }

  # ---------- forms & surveys ----------
  'list-forms'       { Need-Loc; Show-Json (Invoke-Ghl GET "/forms/?locationId=$Loc"); break }
  'form-submissions' { Need-Loc
                       $p = "/forms/submissions?locationId=$Loc"
                       if ($Rest.Count -ge 1) { $p += "&formId=$($Rest[0])" }
                       Show-Json (Invoke-Ghl GET $p); break }
  'list-surveys'     { Need-Loc; Show-Json (Invoke-Ghl GET "/surveys/?locationId=$Loc"); break }
  'survey-submissions' { Need-Loc
                       $p = "/surveys/submissions?locationId=$Loc"
                       if ($Rest.Count -ge 1) { $p += "&surveyId=$($Rest[0])" }
                       Show-Json (Invoke-Ghl GET $p); break }

  # ---------- location config ----------
  'custom-fields'     { Need-Loc; Show-Json (Invoke-Ghl GET "/locations/$Loc/customFields"); break }
  'custom-values'     { Need-Loc; Show-Json (Invoke-Ghl GET "/locations/$Loc/customValues"); break }
  'list-tags'         { Need-Loc; Show-Json (Invoke-Ghl GET "/locations/$Loc/tags"); break }
  'list-users'        { Need-Loc; Show-Json (Invoke-Ghl GET "/users/?locationId=$Loc"); break }
  'list-custom-menus' { Need-Loc; Show-Json (Invoke-Ghl GET "/custom-menus/?locationId=$Loc"); break }

  # ---------- commerce ----------
  'list-products'   { Need-Loc; Show-Json (Invoke-Ghl GET "/products/?locationId=$Loc"); break }
  'product-prices'  { Need-Loc; Need-Args 1 'product-prices <productId>'
                      Show-Json (Invoke-Ghl GET "/products/$($Rest[0])/price?locationId=$Loc"); break }
  'list-invoices'   { Need-Loc; Show-Json (Invoke-Ghl GET "/invoices/?altId=$Loc&altType=location&limit=100&offset=0"); break }
  'list-orders'     { Need-Loc; Show-Json (Invoke-Ghl GET "/payments/orders?altId=$Loc&altType=location"); break }
  'list-transactions' { Need-Loc; Show-Json (Invoke-Ghl GET "/payments/transactions?altId=$Loc&altType=location"); break }
  'list-subscriptions' { Need-Loc; Show-Json (Invoke-Ghl GET "/payments/subscriptions?altId=$Loc&altType=location"); break }

  # ---------- content ----------
  'list-funnels'    { Need-Loc; Show-Json (Invoke-Ghl GET "/funnels/funnel/list?locationId=$Loc"); break }
  'list-links'      { Need-Loc; Show-Json (Invoke-Ghl GET "/links/?locationId=$Loc"); break }
  'list-businesses' { Need-Loc; Show-Json (Invoke-Ghl GET "/businesses/?locationId=$Loc"); break }
  'list-media'      { Need-Loc; Show-Json (Invoke-Ghl GET "/medias/files?altId=$Loc&altType=location"); break }
  'list-email-templates' { Need-Loc; Show-Json (Invoke-Ghl GET "/emails/builder?locationId=$Loc"); break }
  'list-blog-sites' { Need-Loc; Show-Json (Invoke-Ghl GET "/blogs/site/all?locationId=$Loc&limit=50&skip=0"); break }
  'list-social-posts' { Need-Loc; Show-Json (Invoke-Ghl POST "/social-media-posting/$Loc/posts/list" '{"limit":20,"skip":0}'); break }

  # ---------- escape hatch ----------
  'raw' {
    Need-Args 2 'raw <METHOD> <path> [file.json|inline-json]'
    $body = if ($Rest.Count -ge 3) { Body-Of $Rest[2] } else { $null }
    Show-Json (Invoke-Ghl $Rest[0] $Rest[1] $body); break
  }

  default {
    Write-Host "Unknown command '$Command'." -ForegroundColor Red
    Show-Usage
    exit 1
  }
}
