# Export a .docx file to PDF via Microsoft Word COM (Windows only).
# Usage: word-export-pdf.ps1 <input.docx> <output.pdf>
param(
    [Parameter(Mandatory = $true)][string]$InputDocx,
    [Parameter(Mandatory = $true)][string]$OutputPdf
)

$ErrorActionPreference = 'Stop'
$InputDocx = (Resolve-Path -LiteralPath $InputDocx).Path
$OutputPdf = [System.IO.Path]::GetFullPath($OutputPdf)
$outDir = Split-Path -Parent $OutputPdf
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
if (Test-Path -LiteralPath $OutputPdf) {
    Remove-Item -LiteralPath $OutputPdf -Force
}

$word = $null
$doc = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $doc = $word.Documents.Open($InputDocx, $false, $true, $false)
    # 17 = wdExportFormatPDF
    $doc.ExportAsFixedFormat($OutputPdf, 17)
    $doc.Close($false)
    $word.Quit()
    if (-not (Test-Path -LiteralPath $OutputPdf)) {
        throw "PDF was not created: $OutputPdf"
    }
    exit 0
}
catch {
    if ($doc) { try { $doc.Close($false) } catch {} }
    if ($word) { try { $word.Quit() } catch {} }
    Write-Error $_.Exception.Message
    exit 1
}
