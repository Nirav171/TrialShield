param([string]$TestQuery)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $projectRoot '.env'
$geminiModels = @('gemini-3.5-flash-lite', 'gemini-2.5-flash')
$trialCache = @{}
$cacheLifetime = [TimeSpan]::FromMinutes(30)

if (Test-Path -LiteralPath $envPath) {
    foreach ($line in Get-Content -LiteralPath $envPath) {
        if ($line.Trim() -and -not $line.Trim().StartsWith('#') -and $line.Contains('=')) {
            $key, $value = $line.Split('=', 2)
            [Environment]::SetEnvironmentVariable($key.Trim(), $value.Trim().Trim('"').Trim("'"), 'Process')
        }
    }
}

if (-not $env:GEMINI_API_KEY) {
    throw 'GEMINI_API_KEY is missing from .env'
}

function Send-JsonResponse {
    param($Stream, [int]$Status, $Payload)
    $body = $Payload | ConvertTo-Json -Depth 10 -Compress
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes($body)
    $reason = if ($Status -eq 200) { 'OK' } elseif ($Status -eq 400) { 'Bad Request' } elseif ($Status -eq 404) { 'Not Found' } else { 'Bad Gateway' }
    $headers = "HTTP/1.1 $Status $reason`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    $Stream.Write($bodyBytes, 0, $bodyBytes.Length)
    $Stream.Flush()
}

function Find-Trials {
    param([string]$Query)

    $cacheKey = $Query.Trim().ToLowerInvariant()
    if ($script:trialCache.ContainsKey($cacheKey)) {
        $cached = $script:trialCache[$cacheKey]
        if (([DateTime]::UtcNow - $cached.createdAt) -lt $script:cacheLifetime) {
            return $cached.results
        }
        $script:trialCache.Remove($cacheKey)
    }

    $prompt = @"
Use Google Search to find exactly five legitimate official websites offering a
free trial relevant to this user search: $($Query | ConvertTo-Json -Compress).
Only include a result when its official page currently mentions a free trial.
Return only JSON in this exact shape:
{"results":[{"name":"Provider or product","url":"https://official.example/trial","description":"Short trial summary"}]}
Use direct HTTPS provider pages, never search-result, affiliate, coupon, blog,
tracking, shortened, or comparison URLs. Do not invent URLs.
"@

    $payload = @{
        contents = @(@{ parts = @(@{ text = $prompt }) })
        tools = @(@{ google_search = @{} })
        generationConfig = @{
            responseMimeType = 'application/json'
            responseSchema = @{
                type = 'OBJECT'
                properties = @{
                    results = @{
                        type = 'ARRAY'; minItems = 5; maxItems = 5
                        items = @{
                            type = 'OBJECT'
                            properties = @{
                                name = @{ type = 'STRING' }
                                url = @{ type = 'STRING' }
                                description = @{ type = 'STRING' }
                            }
                            required = @('name', 'url', 'description')
                        }
                    }
                }
                required = @('results')
            }
        }
    }

    $headers = @{ 'x-goog-api-key' = $env:GEMINI_API_KEY }
    $requestBody = $payload | ConvertTo-Json -Depth 15 -Compress
    $gemini = $null
    $lastApiError = $null

    foreach ($model in $script:geminiModels) {
        $endpoint = "https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent"
        for ($attempt = 0; $attempt -lt 2; $attempt++) {
            try {
                $gemini = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers `
                    -ContentType 'application/json' -Body $requestBody -TimeoutSec 30
                break
            }
            catch {
                $apiError = $_
                $statusCode = 0
                $errorBody = ''
                if ($apiError.Exception.Response) {
                    $statusCode = [int]$apiError.Exception.Response.StatusCode
                    try {
                        $errorStream = $apiError.Exception.Response.GetResponseStream()
                        $errorReader = [IO.StreamReader]::new($errorStream)
                        $errorBody = $errorReader.ReadToEnd()
                        $errorReader.Dispose()
                    }
                    catch { $errorBody = '' }
                }
                if (-not $statusCode -and $apiError.Exception.Message -match '\((429|408|5\d\d)\)') {
                    $statusCode = [int]$Matches[1]
                }
                if (-not $errorBody -and $apiError.ErrorDetails.Message) {
                    $errorBody = $apiError.ErrorDetails.Message
                }
                $lastApiError = if ($errorBody) { $errorBody } else { $apiError.Exception.Message }
                if ($statusCode -eq 404) { break }
                $isTemporary = $statusCode -eq 429 -or $statusCode -eq 408 -or $statusCode -ge 500
                if (-not $isTemporary) { throw "Gemini API error ($statusCode): $lastApiError" }
                if ($attempt -lt 1) {
                    $jitter = Get-Random -Minimum 100 -Maximum 600
                    $delay = ([Math]::Pow(2, $attempt) * 1000) + $jitter
                    Start-Sleep -Milliseconds $delay
                }
            }
        }
        if ($gemini) { break }
    }

    if (-not $gemini) {
        # Search grounding has a separate quota. Keep the extension functional by
        # asking Gemini without the search tool; content.js verifies terms on click.
        $fallbackPayload = $payload.Clone()
        $fallbackPayload.Remove('tools')
        $fallbackPrompt = $prompt.Replace(
            'Use Google Search to find exactly five legitimate official websites',
            'Using your existing knowledge, identify exactly five legitimate official websites'
        )
        $fallbackPayload.contents = @(@{ parts = @(@{ text = $fallbackPrompt }) })
        try {
            $fallbackEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent'
            $gemini = Invoke-RestMethod -Uri $fallbackEndpoint -Method Post -Headers $headers `
                -ContentType 'application/json' `
                -Body ($fallbackPayload | ConvertTo-Json -Depth 15 -Compress) -TimeoutSec 30
        }
        catch {
            $detail = 'Gemini quota is currently exhausted. Wait a minute and retry, or check this API key project in Google AI Studio.'
            if ($lastApiError -match 'per day|daily|billing|limit.?[^0-9]*0') {
                $detail = 'This Gemini project has no available quota. Enable billing or increase its limits in Google AI Studio, then restart backend.ps1.'
            }
            throw $detail
        }
    }
    $text = $gemini.candidates[0].content.parts[0].text.Trim()
    $text = $text -replace '^```(?:json)?\s*|\s*```$', ''
    $parsed = $text | ConvertFrom-Json

    $results = @()
    foreach ($item in $parsed.results) {
        $uri = $null
        if ($item.name -and [Uri]::TryCreate([string]$item.url, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq 'https') {
            $results += @{
                name = ([string]$item.name).Trim().Substring(0, [Math]::Min(100, ([string]$item.name).Trim().Length))
                url = $uri.AbsoluteUri
                description = ([string]$item.description).Trim().Substring(0, [Math]::Min(240, ([string]$item.description).Trim().Length))
            }
        }
    }
    if ($results.Count -ne 5) { throw 'Gemini did not return five valid trial websites' }
    $script:trialCache[$cacheKey] = @{ createdAt = [DateTime]::UtcNow; results = $results }
    return $results
}

if ($TestQuery) {
    Find-Trials $TestQuery | ConvertTo-Json -Depth 5
    return
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 8787)
try {
    $listener.Start()
}
catch [Net.Sockets.SocketException] {
    $owner = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $ownerPid = if ($owner) { [int]$owner.OwningProcess } else { 0 }
    if (-not $ownerPid) {
        $netstatLine = netstat -ano | Select-String -Pattern ':8787\s+.*LISTENING\s+\d+\s*$' |
            Select-Object -First 1
        if ($netstatLine -and $netstatLine.Line -match '(\d+)\s*$') { $ownerPid = [int]$Matches[1] }
    }
    if ($ownerPid) {
        $ownerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
        $command = if ($ownerProcess.CommandLine) { $ownerProcess.CommandLine } else { $ownerProcess.Name }
        throw "Port 8787 is already in use by PID ${ownerPid}: $command`nIf this is an older TrialShield backend, stop it with: Stop-Process -Id $ownerPid"
    }
    throw "Port 8787 is already in use. Stop the older backend with Ctrl+C, then run backend.ps1 again. Details: $($_.Exception.Message)"
}
Write-Host 'TrialShield search API listening at http://127.0.0.1:8787'

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        $stream = $null
        $reader = $null
        try {
            $stream = $client.GetStream()
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            $requestParts = $requestLine.Split(' ')
            $headers = @{}
            while (($line = $reader.ReadLine()) -ne '') {
                if ($line.Contains(':')) {
                    $headerName, $headerValue = $line.Split(':', 2)
                    $headers[$headerName.Trim().ToLowerInvariant()] = $headerValue.Trim()
                }
            }
            if ($requestParts[0] -eq 'OPTIONS') {
                $preflight = "HTTP/1.1 204 No Content`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: Content-Type`r`nAccess-Control-Allow-Methods: POST, OPTIONS`r`nConnection: close`r`n`r`n"
                $bytes = [Text.Encoding]::ASCII.GetBytes($preflight)
                $stream.Write($bytes, 0, $bytes.Length)
                continue
            }
            if ($requestParts[0] -ne 'POST' -or $requestParts[1] -ne '/search') {
                Send-JsonResponse $stream 404 @{ error = 'Not found' }
                continue
            }
            $contentLength = 0
            if ($headers.ContainsKey('content-length')) { $contentLength = [int]$headers['content-length'] }
            $contentLength = [Math]::Min($contentLength, 10000)
            $buffer = [char[]]::new($contentLength)
            [void]$reader.ReadBlock($buffer, 0, $contentLength)
            $requestBody = (-join $buffer) | ConvertFrom-Json
            $query = ([string]$requestBody.query).Trim()
            if (-not $query -or $query.Length -gt 200) {
                Send-JsonResponse $stream 400 @{ error = 'Query must contain 1 to 200 characters' }
                continue
            }
            Send-JsonResponse $stream 200 @{ results = @(Find-Trials $query) }
        }
        catch {
            if ($stream) { Send-JsonResponse $stream 502 @{ error = "Search failed: $($_.Exception.Message)" } }
        }
        finally {
            if ($reader) { $reader.Dispose() }
            if ($stream) { $stream.Dispose() }
            $client.Dispose()
        }
    }
}
finally {
    $listener.Stop()
}
