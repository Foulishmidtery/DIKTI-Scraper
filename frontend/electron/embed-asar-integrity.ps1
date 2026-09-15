param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$PayloadBase64
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeResourceUpdate {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr BeginUpdateResource(string fileName, bool deleteExistingResources);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UpdateResource(IntPtr handle, string type, string name, ushort language, byte[] data, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EndUpdateResource(IntPtr handle, bool discard);
}
"@

$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$payload = [Convert]::FromBase64String($PayloadBase64)
$handle = [NativeResourceUpdate]::BeginUpdateResource($resolvedExecutable, $false)
if ($handle -eq [IntPtr]::Zero) {
    throw "Tidak dapat membuka executable untuk resource integrity. Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$committed = $false
try {
    if (-not [NativeResourceUpdate]::UpdateResource($handle, "INTEGRITY", "ELECTRONASAR", 1033, $payload, $payload.Length)) {
        throw "Tidak dapat menulis resource integrity. Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    if (-not [NativeResourceUpdate]::EndUpdateResource($handle, $false)) {
        throw "Tidak dapat menyimpan resource integrity. Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $committed = $true
} finally {
    if (-not $committed) {
        [NativeResourceUpdate]::EndUpdateResource($handle, $true) | Out-Null
    }
}
