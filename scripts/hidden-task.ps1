function Get-HiddenTaskLauncher {
    $source = Join-Path $PSScriptRoot 'run-hidden.cs'
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.Substring(0, 16)
    $directory = Join-Path $PSScriptRoot '..\.runner'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $launcher = [IO.Path]::GetFullPath((Join-Path $directory "run-hidden-$hash.exe"))
    if (!(Test-Path -LiteralPath $launcher)) {
        $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        & $compiler /nologo /target:winexe /optimize+ "/out:$launcher" $source
        if ($LASTEXITCODE -ne 0) { throw "Cannot compile the windowless task launcher ($LASTEXITCODE)." }
    }
    return $launcher
}

function New-HiddenCommandTaskAction {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Executable,
        [string]$Arguments = '',
        [Parameter(Mandatory)][string]$Log
    )
    New-ScheduledTaskAction -Execute (Get-HiddenTaskLauncher) -WorkingDirectory $Root -Argument (
        '"{0}" "{1}" "{2}" {3}' -f $Log, $Root, $Executable, $Arguments)
}

function New-HiddenTaskAction {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Script,
        [string]$Arguments = '',
        [Parameter(Mandatory)][string]$Log
    )
    $shell = (Get-Command pwsh.exe -ErrorAction Stop).Source
    New-HiddenCommandTaskAction -Root $Root -Executable $shell -Log $Log -Arguments (
        '-NoProfile -NonInteractive -File "{0}" {1}' -f $Script, $Arguments)
}
