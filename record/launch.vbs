' Diary Workbench Launcher
' Starts local HTTP server (hidden) and opens Edge in app mode (no address bar)

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = "d:\Desktop\" & ChrW(&H9879) & ChrW(&H76EE) & "\record"
pythonExe = "C:\Users\Ran\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\vm\tools\python\python.exe"
edgeExe = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

If Not fso.FileExists(pythonExe) Then
    pythonExe = "python"
End If

Set exec = WshShell.Exec("cmd /c netstat -ano | findstr "":8000 """)
output = ""
Do While Not exec.StdOut.AtEndOfStream
    output = output & exec.StdOut.ReadLine
Loop

If Len(Trim(output)) = 0 Then
    WshShell.CurrentDirectory = projectDir
    On Error Resume Next
    WshShell.Run """" & pythonExe & """ -m http.server 8000", 0, False
    On Error Goto 0
    WScript.Sleep 2000
End If

If fso.FileExists(edgeExe) Then
    WshShell.Run """" & edgeExe & """ --app=http://localhost:8000/"
Else
    WshShell.Run "http://localhost:8000/"
End If
