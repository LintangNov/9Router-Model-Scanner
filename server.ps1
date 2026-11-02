# server.ps1
# Local HTTP server for 9Router Model Scanner Web UI
# Hosts static frontend assets and proxies API requests to 9Router at http://localhost:20128
# Usage: powershell -ExecutionPolicy Bypass -File server.ps1

param(
    [string]$ListenPrefix = "http://localhost:8080/"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- MIME type map for static file serving ---
$MimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".ico"  = "image/x-icon"
    ".png"  = "image/png"
    ".svg"  = "image/svg+xml"
}

# --- Provider preset names to filter out from /v1/models ---
$FilteredPresets = @("heavy", "medium", "light", "free")

# --- Helper: write a JSON response ---
# Headers and status MUST be set before writing to OutputStream.
# The write itself is wrapped so a client disconnect (IOException /
# "network name no longer available") is caught and logged, not fatal.
function Write-JsonResponse {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [object]$Body,
        [int]$StatusCode = 200
    )
    try {
        $json  = $Body | ConvertTo-Json -Depth 10 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

        # Set all headers/status BEFORE touching OutputStream (order matters)
        $Response.StatusCode      = $StatusCode
        $Response.ContentType     = "application/json; charset=utf-8"
        $Response.ContentLength64 = $bytes.Length
        # Add header only if not already present (re-entrant safety)
        if (-not $Response.Headers["Access-Control-Allow-Origin"]) {
            $Response.Headers.Add("Access-Control-Allow-Origin", "*")
        }

        try {
            $Response.OutputStream.Write($bytes, 0, $bytes.Length)
        }
        catch [System.IO.IOException] {
            Write-Host "  [warn] client disconnected during write (IOException): $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
        catch [System.Net.HttpListenerException] {
            Write-Host "  [warn] client disconnected during write (HttpListenerException): $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }
    catch {
        Write-Host "  [warn] Write-JsonResponse failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
    finally {
        try { $Response.OutputStream.Close() } catch {}
    }
}

# --- Helper: write an error JSON response ---
function Write-ErrorResponse {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [string]$Message,
        [int]$StatusCode = 500
    )
    Write-JsonResponse -Response $Response -Body @{ error = $Message } -StatusCode $StatusCode
}

# --- Helper: serve a static file ---
function Serve-StaticFile {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [string]$FilePath
    )
    try {
        if (-not (Test-Path $FilePath)) {
            $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $Response.StatusCode      = 404
            $Response.ContentType     = "text/plain"
            $Response.ContentLength64 = $notFound.Length
            try { $Response.OutputStream.Write($notFound, 0, $notFound.Length) }
            catch [System.IO.IOException]              { Write-Host "  [warn] 404 write disconnected" -ForegroundColor DarkYellow }
            catch [System.Net.HttpListenerException]   { Write-Host "  [warn] 404 write disconnected" -ForegroundColor DarkYellow }
            return
        }

        $ext   = [System.IO.Path]::GetExtension($FilePath).ToLower()
        $mime  = if ($MimeTypes.ContainsKey($ext)) { $MimeTypes[$ext] } else { "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($FilePath)

        # Set all metadata before writing
        $Response.StatusCode      = 200
        $Response.ContentType     = $mime
        $Response.ContentLength64 = $bytes.Length
        $Response.Headers.Add("Cache-Control", "no-cache")

        try { $Response.OutputStream.Write($bytes, 0, $bytes.Length) }
        catch [System.IO.IOException]            { Write-Host "  [warn] static write disconnected: $($_.Exception.Message)" -ForegroundColor DarkYellow }
        catch [System.Net.HttpListenerException] { Write-Host "  [warn] static write disconnected: $($_.Exception.Message)" -ForegroundColor DarkYellow }
    }
    catch {
        Write-Host "  [warn] Serve-StaticFile error: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
    finally {
        try { $Response.OutputStream.Close() } catch {}
    }
}

# --- API: GET /api/models ---
# Fetches models from 9Router, filters presets, groups by provider prefix.
# Retries up to 3 times with a 1-second delay before giving up.
function Handle-GetModels {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [System.Net.HttpListenerResponse]$Response,
        [string]$RouterBaseUrl,
        [string]$ApiKey
    )

    $uri        = "$RouterBaseUrl/v1/models"
    $maxRetries = 3
    $retryDelay = 1   # seconds between attempts
    $raw        = $null
    $lastError  = $null
    $timedOut   = $false

    # Build Invoke-WebRequest params once; reused across retries
    $reqHeaders = @{}
    if ($ApiKey) { $reqHeaders["Authorization"] = "Bearer $ApiKey" }

    $iwrParams = @{
        Uri             = $uri
        Method          = "GET"
        TimeoutSec      = 20
        UseBasicParsing = $true
    }
    if ($reqHeaders.Count -gt 0) { $iwrParams["Headers"] = $reqHeaders }

    # --- Retry loop ---
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        try {
            Write-Host "  -> GET $uri (attempt $attempt/$maxRetries)" -ForegroundColor DarkGray
            $webResponse = Invoke-WebRequest @iwrParams
            $raw = $webResponse.Content
            Write-Host "  -> status $($webResponse.StatusCode), body $($raw.Length) bytes" -ForegroundColor DarkGray
            $lastError = $null
            break   # success — exit retry loop
        }
        catch [System.Net.WebException] {
            $lastError = $_.Exception
            # Distinguish timeout from other network errors
            if ($lastError.Status -eq [System.Net.WebExceptionStatus]::Timeout -or
                $lastError.Message -like "*timed out*" -or
                $lastError.Message -like "*operation has timed out*") {
                $timedOut = $true
                Write-Host "  -> !! attempt $attempt timed out" -ForegroundColor DarkYellow
            } else {
                $timedOut = $false
                Write-Host "  -> !! attempt $attempt network error: $($lastError.Message)" -ForegroundColor DarkYellow
            }
        }
        catch {
            $lastError = $_.Exception
            $timedOut  = $false
            Write-Host "  -> !! attempt $attempt error: $($lastError.Message)" -ForegroundColor DarkYellow
        }

        if ($attempt -lt $maxRetries) {
            Write-Host "  -> retrying in ${retryDelay}s..." -ForegroundColor DarkYellow
            Start-Sleep -Seconds $retryDelay
        }
    }

    # --- All retries exhausted with no successful response ---
    if ($null -eq $raw) {
        if ($timedOut) {
            Write-Host "  -> !! 9Router request timed out after $maxRetries retries" -ForegroundColor Red
            Write-ErrorResponse -Response $Response `
                -Message "9Router request timed out. Please verify 9Router is running at the configured URL." `
                -StatusCode 504
        } else {
            $msg = if ($lastError) { $lastError.Message } else { "Unknown error" }
            Write-Host "  -> !! 9Router request failed after $maxRetries retries: $msg" -ForegroundColor Red
            Write-ErrorResponse -Response $Response -Message "Failed to fetch models: $msg" -StatusCode 502
        }
        return
    }

    # --- Parse and transform the successful response ---
    try {
        $parsed = $raw | ConvertFrom-Json

        # Support both { data: [...] } and a bare array response
        if ($parsed -is [System.Array]) {
            $allModels = $parsed
        } elseif ($null -ne $parsed.data) {
            $allModels = $parsed.data
        } else {
            $allModels = @()
        }

        Write-Host "  -> raw model count: $($allModels.Count)" -ForegroundColor DarkGray

        # Filter out preset model IDs
        $filtered = @($allModels | Where-Object {
            $id = $_.id
            -not ($FilteredPresets -contains $id)
        })

        Write-Host "  -> filtered model count: $($filtered.Count)" -ForegroundColor DarkGray

        # Group by provider prefix (text before first '/')
        $grouped = @{}
        foreach ($m in $filtered) {
            $id = $m.id
            if ($id -match "^([^/]+)/") {
                $provider = $Matches[1]
            } else {
                $provider = "_default"
            }
            if (-not $grouped.ContainsKey($provider)) {
                $grouped[$provider] = [System.Collections.Generic.List[string]]::new()
            }
            $grouped[$provider].Add($id)
        }

        # Build sorted response
        $result = [System.Collections.Generic.List[object]]::new()
        foreach ($provider in ($grouped.Keys | Sort-Object)) {
            $result.Add(@{
                provider = $provider
                models   = @($grouped[$provider] | Sort-Object)
            })
        }

        Write-Host "  -> providers found: $($result.Count)" -ForegroundColor DarkGray
        Write-JsonResponse -Response $Response -Body @{ providers = $result }
    }
    catch {
        $errMsg = $_.Exception.Message
        Write-Host "  !! Handle-GetModels parse error: $errMsg" -ForegroundColor Red
        Write-ErrorResponse -Response $Response -Message "Failed to parse models response: $errMsg"
    }
}

# --- API: POST /api/scan-single ---
# Sends a test chat completion request for one model with a 7-second timeout
function Handle-ScanSingle {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [System.Net.HttpListenerResponse]$Response,
        [string]$RouterBaseUrl,
        [string]$ApiKey
    )
    try {
        # Read request body
        $reader = New-Object System.IO.StreamReader($Request.InputStream)
        $bodyRaw = $reader.ReadToEnd()
        $reader.Close()
        $body = $bodyRaw | ConvertFrom-Json

        $model = $body.model
        if (-not $model) {
            Write-ErrorResponse -Response $Response -Message "Missing 'model' field in request body" -StatusCode 400
            return
        }

        # Build 9Router request payload
        $payload = @{
            model    = $model
            messages = @(@{ role = "user"; content = "." })
            max_tokens = 1
        } | ConvertTo-Json -Depth 5 -Compress

        $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)

        $webReq = [System.Net.WebRequest]::Create("$RouterBaseUrl/v1/chat/completions")
        $webReq.Method = "POST"
        $webReq.ContentType = "application/json"
        $webReq.ContentLength = $payloadBytes.Length
        $webReq.Timeout = 7000   # 7-second timeout per spec

        if ($ApiKey) { $webReq.Headers.Add("Authorization", "Bearer $ApiKey") }

        $reqStream = $webReq.GetRequestStream()
        $reqStream.Write($payloadBytes, 0, $payloadBytes.Length)
        $reqStream.Close()

        try {
            $webRes = $webReq.GetResponse()
            $statusCode = [int]$webRes.StatusCode
            $webRes.Close()
            Write-JsonResponse -Response $Response -Body @{ model = $model; status = $statusCode; ok = $true }
        }
        catch [System.Net.WebException] {
            $webEx = $_.Exception
            if ($webEx.Response -ne $null) {
                $statusCode = [int]$webEx.Response.StatusCode
                $webEx.Response.Close()
                Write-JsonResponse -Response $Response -Body @{ model = $model; status = $statusCode; ok = $false }
            }
            elseif ($webEx.Status -eq [System.Net.WebExceptionStatus]::Timeout) {
                Write-JsonResponse -Response $Response -Body @{ model = $model; status = 0; ok = $false; error = "timeout" }
            }
            else {
                Write-JsonResponse -Response $Response -Body @{ model = $model; status = 0; ok = $false; error = $webEx.Message }
            }
        }
    }
    catch {
        Write-ErrorResponse -Response $Response -Message "Scan error: $($_.Exception.Message)"
    }
}

# --- Main Server Loop ---
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($ListenPrefix)
$listener.Start()

Write-Host "9Router Scanner Web UI running at $ListenPrefix" -ForegroundColor Green
Write-Host "Serving files from: $ScriptDir" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow

try {
    while ($listener.IsListening) {
        # GetContext blocks until a request arrives.
        # Wrap each request in its own try/catch/finally so one bad request
        # never breaks the while loop and kills the server.
        $context = $null
        $res     = $null
        try {
            $context = $listener.GetContext()
            $req     = $context.Request
            $res     = $context.Response

            # Frontend passes router target and API key as custom headers
            $routerBase = $req.Headers["X-Router-Base"]
            if (-not $routerBase) { $routerBase = "http://localhost:20128" }
            $apiKey = $req.Headers["X-Api-Key"]

            $path   = $req.Url.AbsolutePath
            $method = $req.HttpMethod

            Write-Host "[$method] $path" -ForegroundColor DarkGray

            switch -Regex ($path) {
                "^/api/models$" {
                    if ($method -eq "GET") {
                        Handle-GetModels -Request $req -Response $res -RouterBaseUrl $routerBase -ApiKey $apiKey
                    } else {
                        Write-ErrorResponse -Response $res -Message "Method not allowed" -StatusCode 405
                    }
                }
                "^/api/scan-single$" {
                    if ($method -eq "POST") {
                        Handle-ScanSingle -Request $req -Response $res -RouterBaseUrl $routerBase -ApiKey $apiKey
                    } else {
                        Write-ErrorResponse -Response $res -Message "Method not allowed" -StatusCode 405
                    }
                }
                default {
                    # Static file serving
                    $localPath = if ($path -eq "/") { "index.html" } else { $path.TrimStart("/") }
                    $filePath  = Join-Path $ScriptDir $localPath
                    Serve-StaticFile -Response $res -FilePath $filePath
                }
            }
        }
        catch [System.Net.HttpListenerException] {
            # Listener was stopped (Ctrl+C) or OS closed the socket — exit cleanly
            if (-not $listener.IsListening) { break }
            Write-Host "[warn] HttpListenerException on request: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
        catch {
            # Any other unhandled exception from a handler: log it, keep looping
            Write-Host "[error] Unhandled request error: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "        $($_.ScriptStackTrace)" -ForegroundColor Red
        }
        finally {
            # Guarantee the response is always closed, even if a handler forgot
            if ($res -ne $null) {
                try { $res.Close() } catch {}
            }
        }
    }
}
finally {
    $listener.Stop()
    Write-Host "Server stopped." -ForegroundColor Yellow
}
