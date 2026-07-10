$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "This installer is for Windows."
}

$command = Get-Command muxline -ErrorAction Stop
$muxlinePath = $command.Source
if ([string]::IsNullOrWhiteSpace($muxlinePath)) {
    throw "muxline is not on PATH. Build the repository and run npm link first."
}

$taskName = "Muxline Agent"
$escapedPath = $muxlinePath.Replace('"', '""')
$action = New-ScheduledTaskAction `
    -Execute "$env:ComSpec" `
    -Argument "/d /s /c `"`"$escapedPath`" agent`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts the per-user Muxline PTY broker at logon." `
    -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "Muxline agent installed and started as the per-user task '$taskName'."
