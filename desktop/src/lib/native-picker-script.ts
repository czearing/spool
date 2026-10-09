export const nativePickerScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
while ($null -ne ($kind = [Console]::ReadLine())) {
  $dialog = $null
  $owner = $null
  try {
    if ($kind -eq 'folder') {
      $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
      $dialog.Description = 'Choose a folder'
      $dialog.UseDescriptionForTitle = $true
      $dialog.ShowNewFolderButton = $false
    } elseif ($kind -eq 'file') {
      $dialog = [System.Windows.Forms.OpenFileDialog]::new()
      $dialog.Title = 'Choose a file'
      $dialog.CheckFileExists = $true
    } else { throw 'Invalid picker kind.' }
    $owner = [System.Windows.Forms.Form]::new()
    $owner.TopMost = $true
    $path = $null
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
      $path = if ($kind -eq 'folder') { $dialog.SelectedPath } else { $dialog.FileName }
    }
    $result = @{ path = $path }
  } catch { $result = @{ error = $_.Exception.Message } }
  finally {
    if ($dialog) { $dialog.Dispose() }
    if ($owner) { $owner.Dispose() }
  }
  [Console]::WriteLine(($result | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
`;
